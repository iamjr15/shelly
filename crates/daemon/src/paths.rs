use anyhow::{Context, Result, bail};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub fn control_socket_path() -> PathBuf {
    runtime_dir().join("control.sock")
}

pub fn prepare_control_socket(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("control socket path has no parent directory")?;

    if parent.exists() {
        let meta = fs::symlink_metadata(parent).context("stat control socket parent")?;
        if meta.file_type().is_symlink() {
            bail!("refusing to use symlinked control socket parent: {parent:?}");
        }
    }

    fs::create_dir_all(parent).context("create control socket parent")?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .context("chmod control socket parent")?;

    let meta = fs::symlink_metadata(parent).context("stat prepared control socket parent")?;
    if meta.uid() != unsafe { libc::geteuid() } {
        bail!("control socket parent is not owned by the current user: {parent:?}");
    }
    if meta.mode() & 0o777 != 0o700 {
        bail!("control socket parent must be 0700: {parent:?}");
    }

    if path.exists() {
        let meta = fs::symlink_metadata(path).context("stat existing control socket")?;
        if meta.file_type().is_symlink() {
            bail!("refusing to replace symlinked control socket: {path:?}");
        }
        fs::remove_file(path).context("remove stale control socket")?;
    }

    Ok(())
}

pub fn set_control_socket_permissions(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).context("chmod control socket")?;

    let mode = fs::metadata(path)
        .context("stat control socket after chmod")?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o600 {
        bail!("control socket must be 0600: {path:?}");
    }
    Ok(())
}

fn runtime_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(value).join("fieldwork");
    }

    let uid = unsafe { libc::geteuid() };
    std::env::temp_dir().join(format!("fieldwork-{uid}"))
}

#[cfg(test)]
mod tests {
    use super::{prepare_control_socket, set_control_socket_permissions};
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn prepares_owned_private_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let socket = tmp.path().join("runtime").join("control.sock");

        prepare_control_socket(&socket).unwrap();

        let mode = fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn rejects_symlinked_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let linked = tmp.path().join("linked");
        fs::create_dir(&real).unwrap();
        symlink(&real, &linked).unwrap();

        let err = prepare_control_socket(&linked.join("control.sock")).unwrap_err();
        assert!(err.to_string().contains("symlinked control socket parent"));
    }

    #[test]
    fn rejects_symlinked_existing_control_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target.sock");
        let socket = tmp.path().join("runtime").join("control.sock");
        fs::create_dir(socket.parent().unwrap()).unwrap();
        fs::write(&target, b"do not replace").unwrap();
        symlink(&target, &socket).unwrap();

        let err = prepare_control_socket(&socket).unwrap_err();

        assert!(err.to_string().contains("symlinked control socket"));
        assert_eq!(fs::read(&target).unwrap(), b"do not replace");
    }

    #[test]
    fn sets_control_socket_file_mode_to_0600() {
        let tmp = tempfile::tempdir().unwrap();
        let socket = tmp.path().join("control.sock");
        fs::write(&socket, b"test").unwrap();

        set_control_socket_permissions(&socket).unwrap();

        let mode = fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
