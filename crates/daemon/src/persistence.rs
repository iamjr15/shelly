use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, OsRng, rand_core::RngCore},
};
use fieldwork_protocol::{
    DeviceSummary, PushPlatform, SessionId, SessionSummary, decode_bincode, encode_bincode, now_ms,
};
use redb::{Database, DatabaseError, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SERVICE: &str = "app.fieldwork";
const ACCOUNT: &str = "scrollback-key-v1";
const SESSIONS_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("sessions_v1");
const DEVICES_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("devices_v1");
const PLAINTEXT_PREFIX: &[u8] = b"FWP1\0";
const DB_OPEN_LOCK_RETRY_ATTEMPTS: usize = 200;
const DB_OPEN_LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredSession {
    pub summary: SessionSummary,
    pub scrollback_start_seq: u64,
    pub scrollback: Vec<u8>,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredDevice {
    pub name: String,
    pub device_node_id: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    pub push_platform: Option<PushPlatform>,
    pub push_token: Option<String>,
}

impl StoredDevice {
    pub fn new(name: String, device_node_id: String) -> Self {
        Self {
            name,
            device_node_id,
            paired_at: now_ms(),
            last_seen: None,
            push_platform: None,
            push_token: None,
        }
    }

    pub fn summary(&self) -> DeviceSummary {
        DeviceSummary {
            name: self.name.clone(),
            device_node_id: self.device_node_id.clone(),
            paired_at: self.paired_at,
            last_seen: self.last_seen,
            push_platform: self.push_platform,
        }
    }

    pub fn mark_seen(&mut self) {
        self.last_seen = Some(now_ms());
    }

    pub fn set_push_token(&mut self, platform: PushPlatform, token: String) {
        self.push_platform = Some(platform);
        self.push_token = Some(token);
        self.mark_seen();
    }

    pub fn clear_push_token(&mut self) {
        self.push_platform = None;
        self.push_token = None;
        self.mark_seen();
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedBlob {
    nonce: [u8; 24],
    ciphertext: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PlaintextBlob {
    plaintext: Vec<u8>,
}

#[derive(Clone)]
enum PersistenceMode {
    Encrypted { key: [u8; 32] },
    Plaintext { legacy_key: Option<[u8; 32]> },
}

pub struct Persistence {
    sessions_db: std::sync::Arc<Database>,
    devices_db: std::sync::Arc<Database>,
    mode: PersistenceMode,
}

impl Persistence {
    pub fn open_default(encrypt_at_rest: bool) -> Result<Self> {
        let sessions_path = default_sessions_db_path()?;
        let devices_path = default_devices_db_path()?;
        let mode = if encrypt_at_rest {
            PersistenceMode::Encrypted {
                key: load_or_create_keychain_key()?,
            }
        } else {
            PersistenceMode::Plaintext {
                legacy_key: try_load_keychain_key(),
            }
        };
        Self::open_with_paths_and_mode(sessions_path, devices_path, mode)
    }

    #[cfg(test)]
    pub fn open_with_key(path: impl AsRef<Path>, key: [u8; 32]) -> Result<Self> {
        Self::open_with_paths_and_mode(
            path.as_ref(),
            path.as_ref(),
            PersistenceMode::Encrypted { key },
        )
    }

    #[cfg(test)]
    pub fn open_with_key_and_paths(
        sessions_path: impl AsRef<Path>,
        devices_path: impl AsRef<Path>,
        key: [u8; 32],
    ) -> Result<Self> {
        Self::open_with_paths_and_mode(
            sessions_path.as_ref(),
            devices_path.as_ref(),
            PersistenceMode::Encrypted { key },
        )
    }

    #[cfg(test)]
    pub fn open_plaintext(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_paths_and_mode(
            path.as_ref(),
            path.as_ref(),
            PersistenceMode::Plaintext { legacy_key: None },
        )
    }

    fn open_with_paths_and_mode(
        sessions_path: impl AsRef<Path>,
        devices_path: impl AsRef<Path>,
        mode: PersistenceMode,
    ) -> Result<Self> {
        let sessions_path = sessions_path.as_ref();
        let devices_path = devices_path.as_ref();
        let sessions_db = std::sync::Arc::new(open_database(sessions_path)?);
        let devices_db = if sessions_path == devices_path {
            std::sync::Arc::clone(&sessions_db)
        } else {
            std::sync::Arc::new(open_database(devices_path)?)
        };
        Ok(Self {
            sessions_db,
            devices_db,
            mode,
        })
    }

    fn db(&self) -> &Database {
        &self.sessions_db
    }

    fn devices_db(&self) -> &Database {
        &self.devices_db
    }

    pub fn save_session(&self, session: &StoredSession) -> Result<()> {
        let plaintext = encode_bincode(session).context("serialize stored session")?;
        let payload = self.encode_payload(&plaintext)?;
        let id = session.summary.id.to_string();

        let write = self.db().begin_write().context("begin persistence write")?;
        {
            let mut table = write
                .open_table(SESSIONS_TABLE)
                .context("open sessions table")?;
            table
                .insert(id.as_str(), payload.as_slice())
                .context("store session")?;
        }
        write.commit().context("commit persistence write")?;
        Ok(())
    }

    pub fn remove_session(&self, session_id: SessionId) -> Result<()> {
        let id = session_id.to_string();
        let write = self
            .db()
            .begin_write()
            .context("begin persistence delete")?;
        {
            let mut table = write
                .open_table(SESSIONS_TABLE)
                .context("open sessions table")?;
            table.remove(id.as_str()).context("remove session")?;
        }
        write.commit().context("commit persistence delete")?;
        Ok(())
    }

    pub fn load_sessions(&self) -> Result<Vec<StoredSession>> {
        let read = self.db().begin_read().context("begin persistence read")?;
        let Ok(table) = read.open_table(SESSIONS_TABLE) else {
            return Ok(Vec::new());
        };

        let mut sessions = Vec::new();
        for row in table.iter().context("iterate sessions table")? {
            let (_, value) = row.context("read sessions table row")?;
            match self.decode_payload(value.value()).and_then(|plaintext| {
                decode_bincode::<StoredSession>(&plaintext).context("decode stored session")
            }) {
                Ok(session) => sessions.push(session),
                Err(error) => {
                    tracing::warn!(%error, "skipping unreadable persisted session row");
                }
            }
        }
        sessions.sort_by_key(|session| session.summary.created_at);
        Ok(sessions)
    }
}

fn open_database(path: &Path) -> Result<Database> {
    prepare_persistence_path(path)?;
    let db = open_database_with_lock_retry(path)
        .with_context(|| format!("open persistence database {}", path.display()))?;
    set_private_file_permissions(path)?;
    Ok(db)
}

fn open_database_with_lock_retry(path: &Path) -> Result<Database, DatabaseError> {
    for attempt in 0..=DB_OPEN_LOCK_RETRY_ATTEMPTS {
        match Database::create(path) {
            Ok(db) => return Ok(db),
            Err(DatabaseError::DatabaseAlreadyOpen) if attempt < DB_OPEN_LOCK_RETRY_ATTEMPTS => {
                std::thread::sleep(DB_OPEN_LOCK_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("database open retry loop always returns on final attempt")
}

fn prepare_persistence_path(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("persistence path has no parent directory")?;

    if parent.exists() {
        let meta = fs::symlink_metadata(parent).context("stat persistence directory")?;
        if meta.file_type().is_symlink() {
            anyhow::bail!("refusing to use symlinked persistence directory: {parent:?}");
        }
    }

    fs::create_dir_all(parent).context("create persistence directory")?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .context("chmod persistence directory")?;

    let meta = fs::symlink_metadata(parent).context("stat prepared persistence directory")?;
    if meta.uid() != unsafe { libc::geteuid() } {
        anyhow::bail!("persistence directory is not owned by the current user: {parent:?}");
    }
    if meta.mode() & 0o777 != 0o700 {
        anyhow::bail!("persistence directory must be 0700: {parent:?}");
    }

    if path.exists() {
        let meta = fs::symlink_metadata(path).context("stat persistence database")?;
        if meta.file_type().is_symlink() {
            anyhow::bail!("refusing to use symlinked persistence database: {path:?}");
        }
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("chmod persistence database")?;
    let mode = fs::metadata(path)
        .context("stat persistence database after chmod")?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o600 {
        anyhow::bail!("persistence database must be 0600: {path:?}");
    }
    Ok(())
}

impl Persistence {
    pub fn save_device(&self, device: &StoredDevice) -> Result<()> {
        let plaintext = encode_bincode(device).context("serialize stored device")?;
        let payload = self.encode_payload(&plaintext)?;
        let key = device_storage_key(&device.device_node_id);

        let write = self
            .devices_db()
            .begin_write()
            .context("begin device write")?;
        {
            let mut table = write
                .open_table(DEVICES_TABLE)
                .context("open devices table")?;
            table
                .remove(device.device_node_id.as_str())
                .context("remove legacy device key")?;
            table
                .insert(key.as_str(), payload.as_slice())
                .context("store device")?;
        }
        write.commit().context("commit device write")?;
        Ok(())
    }

    pub fn remove_device(&self, device_node_id: &str) -> Result<()> {
        let key = device_storage_key(device_node_id);
        let write = self
            .devices_db()
            .begin_write()
            .context("begin device delete")?;
        {
            let mut table = write
                .open_table(DEVICES_TABLE)
                .context("open devices table")?;
            table.remove(key.as_str()).context("remove device")?;
            table
                .remove(device_node_id)
                .context("remove legacy device key")?;
        }
        write.commit().context("commit device delete")?;
        Ok(())
    }

    pub fn load_devices(&self) -> Result<Vec<StoredDevice>> {
        let read = self
            .devices_db()
            .begin_read()
            .context("begin devices read")?;
        let Ok(table) = read.open_table(DEVICES_TABLE) else {
            return Ok(Vec::new());
        };

        let mut devices = Vec::new();
        for row in table.iter().context("iterate devices table")? {
            let (_, value) = row.context("read devices table row")?;
            match self.decode_payload(value.value()).and_then(|plaintext| {
                decode_bincode::<StoredDevice>(&plaintext).context("decode stored device")
            }) {
                Ok(device) => devices.push(device),
                Err(error) => {
                    tracing::warn!(%error, "skipping unreadable persisted device row");
                }
            }
        }
        devices.sort_by_key(|device| device.paired_at);
        Ok(devices)
    }

    fn encode_payload(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        match &self.mode {
            PersistenceMode::Encrypted { key } => {
                let encrypted = encrypt(key, plaintext)?;
                encode_bincode(&encrypted).context("serialize encrypted payload")
            }
            PersistenceMode::Plaintext { .. } => {
                let payload = PlaintextBlob {
                    plaintext: plaintext.to_vec(),
                };
                let mut encoded = PLAINTEXT_PREFIX.to_vec();
                encoded.extend(encode_bincode(&payload).context("serialize plaintext payload")?);
                Ok(encoded)
            }
        }
    }

    fn decode_payload(&self, payload: &[u8]) -> Result<Vec<u8>> {
        if let Some(plaintext) = decode_plaintext_payload(payload)? {
            return Ok(plaintext);
        }

        match &self.mode {
            PersistenceMode::Encrypted { key } => {
                if let Ok(encrypted) = decode_bincode::<EncryptedBlob>(payload) {
                    return decrypt(key, &encrypted);
                }
                anyhow::bail!("stored payload is neither encrypted nor Fieldwork plaintext");
            }
            PersistenceMode::Plaintext { legacy_key } => {
                if let Some(key) = legacy_key {
                    let encrypted: EncryptedBlob =
                        decode_bincode(payload).context("decode legacy encrypted payload")?;
                    return decrypt(key, &encrypted);
                }
                anyhow::bail!(
                    "stored payload is not plaintext and no legacy keychain key is available"
                );
            }
        }
    }
}

fn decode_plaintext_payload(payload: &[u8]) -> Result<Option<Vec<u8>>> {
    let Some(encoded) = payload.strip_prefix(PLAINTEXT_PREFIX) else {
        return Ok(None);
    };
    let plaintext: PlaintextBlob =
        decode_bincode(encoded).context("decode plaintext stored payload")?;
    Ok(Some(plaintext.plaintext))
}

fn device_storage_key(device_node_id: &str) -> String {
    let hash = Sha256::digest(device_node_id.as_bytes());
    let mut out = String::with_capacity("sha256:".len() + 64);
    out.push_str("sha256:");
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<EncryptedBlob> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| anyhow::anyhow!("encrypt stored session"))?;
    Ok(EncryptedBlob { nonce, ciphertext })
}

fn decrypt(key: &[u8; 32], encrypted: &EncryptedBlob) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            XNonce::from_slice(&encrypted.nonce),
            encrypted.ciphertext.as_ref(),
        )
        .map_err(|_| anyhow::anyhow!("decrypt stored session"))
}

fn load_or_create_keychain_key() -> Result<[u8; 32]> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).context("open OS keychain entry")?;
    match entry.get_password() {
        Ok(encoded) => decode_key(&encoded),
        Err(keyring::Error::NoEntry) => {
            let mut key = [0_u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD_NO_PAD.encode(key))
                .context("store persistence key in OS keychain")?;
            Ok(key)
        }
        Err(error) => Err(error).context("read persistence key from OS keychain"),
    }
}

fn try_load_keychain_key() -> Option<[u8; 32]> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
    let encoded = entry.get_password().ok()?;
    decode_key(&encoded).ok()
}

fn decode_key(encoded: &str) -> Result<[u8; 32]> {
    let bytes = STANDARD_NO_PAD
        .decode(encoded)
        .context("decode persistence key")?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("persistence key must be 32 bytes"))?;
    Ok(key)
}

fn default_sessions_db_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is required for persistence path")?;

    if cfg!(target_os = "macos") {
        return Ok(home
            .join("Library")
            .join("Caches")
            .join("app.fieldwork")
            .join("sessions.redb"));
    }

    if let Some(cache_home) = std::env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(cache_home)
            .join("fieldwork")
            .join("sessions.redb"));
    }

    Ok(home.join(".cache").join("fieldwork").join("sessions.redb"))
}

fn default_devices_db_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is required for persistence path")?;

    if cfg!(target_os = "macos") {
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("app.fieldwork")
            .join("devices.redb"));
    }

    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(data_home)
            .join("fieldwork")
            .join("devices.redb"));
    }

    Ok(home
        .join(".local")
        .join("share")
        .join("fieldwork")
        .join("devices.redb"))
}

#[cfg(test)]
mod tests {
    use super::{DEVICES_TABLE, Persistence, SESSIONS_TABLE, StoredDevice, StoredSession};
    use fieldwork_protocol::{AgentState, SessionId, SessionSummary, now_ms};
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;

    #[test]
    fn stores_and_loads_encrypted_session_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let persistence = Persistence::open_with_key(tmp.path().join("sessions.redb"), [7; 32])
            .expect("open persistence");
        let session = StoredSession {
            summary: SessionSummary {
                id: SessionId::new(),
                name: "bash · test".to_string(),
                command: vec!["bash".to_string()],
                cwd: PathBuf::from("/tmp"),
                created_at: now_ms(),
                last_activity: now_ms(),
                state: AgentState::Idle,
                last_line: Some("secret-output".to_string()),
                model: None,
            },
            scrollback_start_seq: 5,
            scrollback: b"secret-output\r\n".to_vec(),
            exit_code: Some(0),
        };

        persistence.save_session(&session).unwrap();
        let loaded = persistence.load_sessions().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].summary.id, session.summary.id);
        assert_eq!(loaded[0].scrollback, session.scrollback);

        let raw = std::fs::read(tmp.path().join("sessions.redb")).unwrap();
        assert!(
            !raw.windows(b"secret-output".len())
                .any(|window| window == b"secret-output")
        );
    }

    #[test]
    fn load_sessions_skips_unreadable_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let persistence = Persistence::open_with_key(tmp.path().join("sessions.redb"), [14; 32])
            .expect("open persistence");
        let session = StoredSession {
            summary: SessionSummary {
                id: SessionId::new(),
                name: "bash · test".to_string(),
                command: vec!["bash".to_string()],
                cwd: PathBuf::from("/tmp"),
                created_at: now_ms(),
                last_activity: now_ms(),
                state: AgentState::Idle,
                last_line: None,
                model: None,
            },
            scrollback_start_seq: 0,
            scrollback: Vec::new(),
            exit_code: None,
        };
        persistence.save_session(&session).unwrap();

        let write = persistence.sessions_db.begin_write().unwrap();
        {
            let mut table = write.open_table(SESSIONS_TABLE).unwrap();
            table
                .insert("corrupt-session", b"not a stored session".as_slice())
                .unwrap();
        }
        write.commit().unwrap();

        let loaded = persistence.load_sessions().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].summary.id, session.summary.id);
    }

    #[test]
    fn load_devices_skips_unreadable_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let persistence = Persistence::open_with_key(tmp.path().join("sessions.redb"), [15; 32])
            .expect("open persistence");
        let device = StoredDevice::new("Alice Phone".to_string(), "node-secret".to_string());
        persistence.save_device(&device).unwrap();

        let write = persistence.devices_db.begin_write().unwrap();
        {
            let mut table = write.open_table(DEVICES_TABLE).unwrap();
            table
                .insert("corrupt-device", b"not a stored device".as_slice())
                .unwrap();
        }
        write.commit().unwrap();

        let loaded = persistence.load_devices().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Alice Phone");
    }

    #[test]
    fn stores_and_loads_encrypted_device_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let persistence = Persistence::open_with_key(tmp.path().join("sessions.redb"), [8; 32])
            .expect("open persistence");
        let device = StoredDevice::new("Alice Phone".to_string(), "node-secret".to_string());

        persistence.save_device(&device).unwrap();
        let loaded = persistence.load_devices().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Alice Phone");

        let raw = std::fs::read(tmp.path().join("sessions.redb")).unwrap();
        for secret in [b"Alice Phone".as_slice(), b"node-secret"] {
            assert!(!raw.windows(secret.len()).any(|window| window == secret));
        }
    }

    #[test]
    fn separate_device_registry_db_is_private_and_encrypted() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions_path = tmp.path().join("cache").join("sessions.redb");
        let devices_path = tmp.path().join("data").join("devices.redb");
        let persistence =
            Persistence::open_with_key_and_paths(&sessions_path, &devices_path, [13; 32])
                .expect("open persistence with separate databases");
        let mut device = StoredDevice::new("Alice Phone".to_string(), "node-secret".to_string());
        device.set_push_token(
            fieldwork_protocol::PushPlatform::Fcm,
            "secret-fcm-token".to_string(),
        );

        persistence.save_device(&device).unwrap();
        let loaded = persistence.load_devices().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Alice Phone");
        assert_eq!(loaded[0].push_token.as_deref(), Some("secret-fcm-token"));
        drop(persistence);

        for path in [&sessions_path, &devices_path] {
            let parent_mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(parent_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }

        let raw_devices = std::fs::read(devices_path).unwrap();
        for secret in [
            b"Alice Phone".as_slice(),
            b"node-secret",
            b"secret-fcm-token",
        ] {
            assert!(
                !raw_devices
                    .windows(secret.len())
                    .any(|window| window == secret)
            );
        }
    }

    #[test]
    fn explicit_plaintext_mode_stores_session_payload_without_encryption() {
        let tmp = tempfile::tempdir().unwrap();
        let persistence = Persistence::open_plaintext(tmp.path().join("sessions.redb"))
            .expect("open plaintext persistence");
        let session = StoredSession {
            summary: SessionSummary {
                id: SessionId::new(),
                name: "bash · test".to_string(),
                command: vec!["bash".to_string()],
                cwd: PathBuf::from("/tmp"),
                created_at: now_ms(),
                last_activity: now_ms(),
                state: AgentState::Idle,
                last_line: Some("plaintext-output".to_string()),
                model: None,
            },
            scrollback_start_seq: 5,
            scrollback: b"plaintext-output\r\n".to_vec(),
            exit_code: Some(0),
        };

        persistence.save_session(&session).unwrap();
        let loaded = persistence.load_sessions().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scrollback, session.scrollback);

        let raw = std::fs::read(tmp.path().join("sessions.redb")).unwrap();
        assert!(
            raw.windows(b"plaintext-output".len())
                .any(|window| window == b"plaintext-output")
        );
    }

    #[test]
    fn explicit_plaintext_mode_stores_device_registry_without_encryption() {
        let tmp = tempfile::tempdir().unwrap();
        let persistence = Persistence::open_plaintext(tmp.path().join("sessions.redb"))
            .expect("open plaintext persistence");
        let device = StoredDevice::new("Alice Phone".to_string(), "node-secret".to_string());

        persistence.save_device(&device).unwrap();
        let loaded = persistence.load_devices().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Alice Phone");

        let raw = std::fs::read(tmp.path().join("sessions.redb")).unwrap();
        assert!(
            raw.windows(b"Alice Phone".len())
                .any(|window| window == b"Alice Phone")
        );
    }

    #[test]
    fn encrypted_mode_can_read_previous_plaintext_payloads_after_reenable() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("sessions.redb");
        let plaintext = Persistence::open_plaintext(&path).expect("open plaintext persistence");
        let session = StoredSession {
            summary: SessionSummary {
                id: SessionId::new(),
                name: "bash · test".to_string(),
                command: vec!["bash".to_string()],
                cwd: PathBuf::from("/tmp"),
                created_at: now_ms(),
                last_activity: now_ms(),
                state: AgentState::Idle,
                last_line: Some("plaintext-output".to_string()),
                model: None,
            },
            scrollback_start_seq: 5,
            scrollback: b"plaintext-output\r\n".to_vec(),
            exit_code: Some(0),
        };
        plaintext.save_session(&session).unwrap();
        drop(plaintext);

        let encrypted = Persistence::open_with_key(&path, [9; 32]).expect("open persistence");
        let loaded = encrypted.load_sessions().unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scrollback, session.scrollback);
    }

    #[test]
    fn persistence_database_uses_private_parent_and_file_modes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("state").join("sessions.redb");

        let persistence = Persistence::open_with_key(&path, [10; 32]).expect("open persistence");
        drop(persistence);

        let parent_mode = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;

        assert_eq!(parent_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }

    #[test]
    fn persistence_rejects_symlinked_parent_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let linked = tmp.path().join("linked");
        fs::create_dir(&real).unwrap();
        symlink(&real, &linked).unwrap();

        let err = match Persistence::open_with_key(linked.join("sessions.redb"), [11; 32]) {
            Ok(_) => panic!("symlinked persistence directory was accepted"),
            Err(error) => error,
        };

        assert!(err.to_string().contains("symlinked persistence directory"));
    }

    #[test]
    fn persistence_rejects_symlinked_database_file() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real.redb");
        let linked = tmp.path().join("linked.redb");
        fs::write(&real, b"placeholder").unwrap();
        symlink(&real, &linked).unwrap();

        let err = match Persistence::open_with_key(&linked, [12; 32]) {
            Ok(_) => panic!("symlinked persistence database was accepted"),
            Err(error) => error,
        };

        assert!(err.to_string().contains("symlinked persistence database"));
    }
}
