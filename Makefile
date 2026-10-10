# brust v2 — one-shot dev loop.
#
# `brust dev` (watch / HMR) is M3 work (M2 spec §0, ledger F61). Until it ships the loop is
# install → napi addon → `brust build` → `brust start`, and `make dev` runs all of it. Every
# step before `start` is stamped, so re-running `make dev` after an edit only redoes what is
# stale: the addon rebuilds when crates/, vendor/ or Cargo.lock change (a stale addon makes
# `brust build` use old compiler output silently), `bun install` reruns when a package.json or
# bun.lock changes, and `brust build` always runs (it is cheap and owns its own cache).
#
#   make dev                              # pokedex on http://127.0.0.1:1337
#   make dev APP=examples/pokedex PORT=4000 WORKERS=2
#   make dev RELEASE=1                    # release addon (what bench/run.ts requires)
#   make build | make start | make addon | make install | make clean
#
# GNU Make 3.81 (the macOS default) is enough: no .ONESHELL, no `!=`.

SHELL := /bin/bash

APP     ?= examples/pokedex
ENTRY   ?= routes.tsx
PORT    ?= 1337
WORKERS ?=
RELEASE ?=

BRUST         := bun $(CURDIR)/packages/brust/bin/brust
NATIVE_DIR    := packages/brust/native
ADDON         := $(NATIVE_DIR)/index.js
ADDON_MODE    := $(if $(RELEASE),release,debug)
ADDON_SCRIPT  := $(if $(RELEASE),build,build:debug)
ADDON_STAMP   := target/.brust-addon-$(ADDON_MODE)
INSTALL_STAMP := node_modules/.brust-install-stamp
START_FLAGS   := --port $(PORT) $(if $(WORKERS),--workers $(WORKERS),)

PKG_FILES := package.json bun.lock \
  $(wildcard packages/*/package.json examples/*/package.json npm/*/package.json tests/server/package.json bench/package.json bench/apps/*/package.json)
RUST_FILES := Cargo.toml Cargo.lock rust-toolchain.toml \
  $(shell find crates vendor -type f \( -name '*.rs' -o -name 'Cargo.toml' \) -not -path '*/target/*')

.PHONY: dev install addon build start clean

dev: build
	cd $(APP) && $(BRUST) start $(START_FLAGS)

install: $(INSTALL_STAMP)
$(INSTALL_STAMP): $(PKG_FILES)
	bun install
	@mkdir -p node_modules && touch $@

# Switching RELEASE on/off writes a fresh mode stamp, which is newer than index.js → rebuild.
$(ADDON_STAMP):
	@mkdir -p target && rm -f target/.brust-addon-* && touch $@

addon: $(ADDON)
$(ADDON): $(INSTALL_STAMP) $(ADDON_STAMP) $(RUST_FILES)
	cd packages/brust && bun run $(ADDON_SCRIPT)

build: $(INSTALL_STAMP) $(ADDON)
	cd $(APP) && $(BRUST) build $(ENTRY)

start:
	cd $(APP) && $(BRUST) start $(START_FLAGS)

clean:
	rm -rf $(APP)/dist $(NATIVE_DIR)/*.node $(ADDON) $(NATIVE_DIR)/index.d.ts \
	  $(INSTALL_STAMP) target/.brust-addon-*
