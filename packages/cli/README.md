# fieldwork

The npm meta-package for Fieldwork. It installs the matching platform package
through optional dependencies, then swaps `bin/fieldwork` and `bin/fieldworkd`
to native binaries when postinstall scripts are allowed. If postinstall is
skipped, both commands fall back to dispatching into the matching platform
package.

```sh
npm i -g fieldwork
```
