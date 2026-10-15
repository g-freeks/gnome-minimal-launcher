UUID := minimal-activities-overview@g-freeks.github.io
ZIP := $(UUID).shell-extension.zip

.PHONY: schemas pack install enable disable clean logs

schemas:
	glib-compile-schemas --strict schemas/

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

# Development VM (see vm/vm for the full command set)
.PHONY: vm-create vm-start vm-stop vm-reload vm-logs vm-screenshot

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
