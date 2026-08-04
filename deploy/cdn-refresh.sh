#!/usr/bin/env bash
# cdn-refresh.sh — publish a release to the CDN NOW instead of waiting for the
# host's ≤10-min timer. Run after deploy/release.sh has pushed a tag.
#
#   deploy/cdn-refresh.sh <version> [--no-wait] [--dry-run]
#     <version>   the release just pushed, e.g. 0.1.1
#     --no-wait   don't wait for the GitHub build; trigger immediately
#     --dry-run   wait, then print the trigger command without running it
#
# The CDN (cdn.thern.io) is PULL-based and firewalled; the way in is the ssh
# alias `cdn`, which your own ~/.ssh/config defines. This waits for the release
# build to attach the .deb, then runs the host's pull once.
#
# The version is named on the way in, and checked on the way out. Both matter,
# and 0.1.13 is why:
#
#   * Naming it. The host resolves a bare run through GitHub's releases/latest,
#     which only flips when the release goes public — a different moment from
#     the .deb being attached, which is what this script waits for. On 0.1.13
#     the trigger and the publish landed in the same second, latest still said
#     0.1.12, and the host correctly decided it had nothing to do. Passing the
#     version resolves the tag directly and takes the timing out of it.
#   * Checking it. The old read-back was skipped without CDN credentials and
#     only ever logged what it found, so a publish that did not happen exited 0
#     and the release looked done. The repo is public, so the index is readable
#     without credentials; a version that never appears is now a failure.
#
# Idempotent: cdn-pull.sh records the last-published version and no-ops when
# already current, so re-running (or the timer also firing) is harmless.
set -euo pipefail

VER="${1:?usage: cdn-refresh.sh <version> [--no-wait] [--dry-run]}"; shift || true
VER="${VER#v}"; TAG="v$VER"
# It ends up in a command line on the far side of ssh, so keep it to the shape
# a version actually has rather than quoting it and hoping.
case "$VER" in
    ''|*[!0-9.]*) printf 'cdn-refresh: not a version: %s\n' "$VER" >&2; exit 2 ;;
esac
NOWAIT=0; DRY=0
for a in "$@"; do
    case "$a" in
        --no-wait) NOWAIT=1 ;;
        --dry-run) DRY=1 ;;
        *) printf 'cdn-refresh: unknown option: %s\n' "$a" >&2; exit 2 ;;
    esac
done

REPO="${TABDESK_REPO:-TheJonaz/tabdesk}"
SSH_CDN="${TABDESK_CDN_SSH:-cdn}"
WAIT_TRIES="${TABDESK_CDN_WAIT_TRIES:-40}"        # 40 × 30s = up to ~20 min
PULL_BIN="${TABDESK_CDN_PULL_BIN:-/usr/local/bin/tabdesk-cdn-pull}"
VERIFY_TRIES="${TABDESK_CDN_VERIFY_TRIES:-12}"    # 12 × 5s = up to 1 min
PACKAGES_URL="${TABDESK_CDN_PACKAGES_URL:-https://cdn.thern.io/tabdesk/dists/stable/main/binary-amd64/Packages}"
log(){ printf 'cdn-refresh: %s\n' "$*"; }

# What the apt index actually offers right now — the only answer that settles
# whether a release reached users. Public, so this normally needs nothing; the
# credentialed path stays for the case where the repo goes back behind HTTP
# Basic auth, and an empty answer means "could not look", never "not published".
published_version(){
    local out cfg cdn_auth authfile=/etc/apt/auth.conf.d/tabdesk.conf
    out="$(curl -fsS -4 --max-time 15 "$PACKAGES_URL" 2>/dev/null)" || out=""
    if [ -z "$out" ]; then
        cdn_auth="${TABDESK_CDN_AUTH:-}"
        if [ -z "$cdn_auth" ] && [ -r "$authfile" ]; then
            cdn_auth="$(awk '/^login/{u=$2} /^password/{p=$2} END{if (u && p) print u ":" p}' "$authfile")"
        fi
        if [ -n "$cdn_auth" ]; then
            cfg="$(mktemp)"; chmod 600 "$cfg"
            printf 'user = "%s"\n' "$cdn_auth" > "$cfg"
            out="$(curl -fsS -4 --max-time 15 --config "$cfg" "$PACKAGES_URL" 2>/dev/null)" || out=""
            rm -f "$cfg"
        fi
    fi
    printf '%s' "$out" | awk -F': ' '/^Version:/{print $2; exit}'
}

# 1. Wait for the release build to attach the .deb (best-effort).
if [ "$NOWAIT" = 0 ] && command -v gh >/dev/null 2>&1; then
    log "waiting for $TAG to build on GitHub (up to ~20 min; --no-wait to skip)…"
    ok=0
    for _ in $(seq 1 "$WAIT_TRIES"); do
        have="$(gh release view "$TAG" --repo "$REPO" --json assets \
                   -q '[.assets[].name]|join(" ")' 2>/dev/null || true)"
        case " $have " in *_amd64.deb*) ok=1; break ;; esac
        sleep 30
    done
    [ "$ok" = 1 ] && log "the .deb is attached to $TAG." \
                  || log "timed out waiting — triggering anyway (host pulls whatever is ready)."
else
    log "not waiting for the build."
fi

# 2. Trigger the host to pull + publish this exact version.
TRIGGER="$PULL_BIN $VER"
if [ "$DRY" = 1 ]; then
    log "dry-run — would run:  ssh $SSH_CDN '$TRIGGER'"
    exit 0
fi
log "triggering a publish of $VER on '$SSH_CDN'…"
if ! ssh -o ConnectTimeout=25 "$SSH_CDN" "$TRIGGER"; then
    log "could not publish on '$SSH_CDN' — the CDN will still update within ~10 min via its timer." >&2
    exit 1
fi

# 3. Confirm it from the outside. The host exiting 0 says its own run finished,
#    not that the index users read has moved; on 0.1.13 those were different
#    things. Poll, because the publish writes the pool and the index in that
#    order and the mirror in front of them is not instant.
got=""
for _ in $(seq 1 "$VERIFY_TRIES"); do
    got="$(published_version)"
    [ "$got" = "$VER" ] && break
    sleep 5
done
if [ "$got" = "$VER" ]; then
    log "done — CDN now serves TabDesk $VER."
elif [ -n "$got" ]; then
    log "FAILED — the CDN still serves $got, not $VER. Users would install the old one." >&2
    exit 1
else
    log "FAILED — could not read the published version back from $PACKAGES_URL." >&2
    exit 1
fi
