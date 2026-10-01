UUID := actionview@kanterlabs.dev
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions
BUILD := build

.PHONY: test lint smoke check schemas pack install uninstall fixtures capture shots clean

## Core unit tests (pure JS) under both runtimes
test:
	gjs -m tests/core.test.js
	node tests/core.test.js

lint:
	npx --yes eslint@10 .

## Headless gnome-shell end-to-end (needs gnome-shell + gjs installed)
smoke:
	tools/smoke.sh $(BUILD)/smoke

check: lint test smoke

schemas:
	glib-compile-schemas --strict $(UUID)/schemas

pack:
	mkdir -p $(BUILD)
	gnome-extensions pack --force --out-dir=$(BUILD) \
		--extra-source=lib --extra-source=icons $(UUID)
	python3 ci/canonicalize_zip.py $(BUILD)/$(UUID).shell-extension.zip
	@echo "→ $(BUILD)/$(UUID).shell-extension.zip"

## Install for the current user. Log out/in (Wayland) then: gnome-extensions enable $(UUID)
install: pack
	gnome-extensions install --force $(BUILD)/$(UUID).shell-extension.zip

uninstall:
	gnome-extensions uninstall $(UUID) || rm -rf $(EXT_DIR)/$(UUID)

## Re-capture the live payload over ssh and regenerate scenario fixtures
capture:
	tools/capture-fixture.sh base
	tools/make-fixtures.py

fixtures:
	tools/make-fixtures.py

clean:
	rm -rf $(BUILD) $(UUID)/schemas/gschemas.compiled

## Regenerate README screenshots from real headless renders
shots: smoke
	python3 tools/readme-shots.py $(BUILD)/smoke docs/assets
