UUID := minimal-activities-overview@g-freeks.github.io
ZIP := $(UUID).shell-extension.zip

.PHONY: schemas pack install enable disable clean logs lint check

schemas:
	glib-compile-schemas --strict schemas/

lint:
	npm run lint

# What CI runs per GNOME version, against the shell installed here
check: lint schemas
	ci/check-shell-api.sh

pack:
	gnome-extensions pack --force --extra-source=popup.js .

install: pack
	gnome-extensions install --force $(ZIP)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(ZIP) schemas/gschemas.compiled

# Development VMs, one per GNOME version: make vm-reload GNOME=49
# (default 50; see vm/common.sh and vm/vm for the full command set)
export GNOME
.PHONY: vm-create vm-start vm-stop vm-reload vm-logs vm-screenshot vm-smoke

vm-create:
	vm/create.sh

vm-start: schemas
	vm/vm start

vm-stop:
	vm/vm stop

# The repo is the VM's installed extension (virtiofs + symlink), so a
# reload is just compiling schemas and restarting the VM's session.
vm-reload: schemas
	vm/vm restart-shell

vm-logs:
	vm/vm logs -n 100

vm-screenshot:
	vm/vm screenshot

# End-to-end popup checks with real key presses (VM must be running)
vm-smoke:
	vm/smoke-test.sh
