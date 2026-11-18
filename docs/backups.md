# Backups

```yaml
# fornax.yaml
backup:
  storage_box:                     # Hetzner Storage Box (SSH/SFTP on port 23)
    host: u123456.your-storagebox.de
    user: u123456-sub1
    password: op://Infra/Storage Box/password   # optional: lets fornax install each server's key itself
  at: "03:15"                      # UTC
  keep: { daily: 7, weekly: 4, monthly: 6 }
  heartbeat: op://Infra/healthchecks/backup-url # optional, healthchecks.io style (<url>/fail on errors)
```

Every night (`fornax-backup.timer`) each site gets one restic snapshot: a dump of its database (PostgreSQL custom format or mysqldump), its shared paths (Laravel: `storage/`) and its `.env`, plus `backup.paths` from the site config. Encrypted with a per-server restic password that fornax generates and — with 1Password configured — stores right away.

The files are read by the site's user, never by root: its `tar` packs them, and restic gets one stream, the database dump first (`<domain>.tar` in the snapshot). A file the user cannot read fails the site's backup and is named in `fornax backup status`; a site whose user is missing is not backed up. Restoring works the other way round: root takes its dump off the front, and the site's user unpacks its own part — into `<root>/restore-<stamp>/` side by side (a path from outside the site root under its full path, e.g. `restore-<stamp>/var/data/…`), or with `--replace` into `<root>/.restore-<stamp>/` and from there over the live paths (`rsync --delete`, every file rewritten), as that user. A path the snapshot does not hold stays as it is; a site whose user is missing cannot have its files restored.

```bash
fornax backup status web-1          # last snapshot per site, next run; exit 1 if a site failed or is older than 26 h
fornax backup run web-1 [--site …]  # now
fornax backup list shop.example.com
fornax backup restore shop.example.com                 # side by side: database shop_restore_<stamp>, files in <root>/restore-<stamp>/
fornax backup restore shop.example.com --only db --replace --confirm=shop.example.com   # overwrite the live data
```
