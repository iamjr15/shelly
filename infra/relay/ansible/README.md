# Relay deployment contract

Relay schema changes must be **expand-only and downgrade-readable**. A release may add tables,
indexes, or nullable/defaulted columns, but it must not drop, rename, or reinterpret anything the
previous binary reads. Destructive cleanup requires a later release after the older binary can no
longer be selected for rollback.

`playbook.yml` stages the installed binary and creates one consistent pre-migration database
snapshot with SQLite's online backup API before starting the new binary. Its normal rescue path
restores only the binary. It restores the snapshot only when the snapshot passed `PRAGMA
quick_check` before rollout, the live database fails that check after the new binary starts, and the
new control-plane journal independently identifies a SQLite/database failure. This prevents a
generic service or health failure from being mislabeled as a migration failure.

`rollback.yml` is used for failures observed by the GitHub runner after Ansible succeeds. It has no
database restore path: public health, version, or rendezvous-smoke failures roll back the binary in
place and preserve all database writes made during or after deployment.
