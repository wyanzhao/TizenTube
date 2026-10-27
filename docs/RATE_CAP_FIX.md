# Playback-rate quality fix

## Symptom

On Samsung Tizen TVs that use the built-in Cobalt YouTube player, setting the speed to anything
other than 1x on a 60 fps video drops the picture to 480p. 30 fps videos are not affected.

## Root cause

The YouTube TV player (`tv-player-es6.js`, analysed at player build `cbcfbf2f`; minified names
change between builds) applies an extra quality cap whenever

* the playback rate is above 1, **and**
* the video offers any format above 32 fps.

To compute the cap it walks the formats between 480p and 1080p (2160p on AV1-8K capable devices)
and keeps a format only if

```
MediaSource.isTypeSupported('<mime>; width=W; height=H; framerate=<fps × rate>; bitrate=<bps × rate>')
```

returns true. The cap starts at 480p. Cobalt on the tested TV honours the `framerate`
parameter and answers **false for every framerate above 60**, so a 60 fps video at 1.25x
(75), 1.5x (90) or 2x (120) is capped at 480p. If you pick a higher quality manually while
the cap applies, the player resets the speed to 1x instead.

## The fix

`mods/features/rateCapFix.js` wraps `MediaSource.isTypeSupported` once at page start.
A video query with `60 < framerate <= 120` and `height <= 1080` is passed to Cobalt as
`framerate=60`, with `bitrate` divided by the same factor. In other words, Cobalt is asked
whether it can decode the format at its native rate. Every other query, including the
player's own `framerate=9999` probe, passes through unchanged.

There is no polling, no forced quality lock, no page reload and no format filtering. Because
the player now computes the cap normally, YouTube's own speed menu works as well.

The 1080p limit is the envelope that was measured. 1440p and 2160p queries are not rewritten.

## Measurements (Samsung QN90A, 2021, Tizen 6.0)

Test clip: a 60 fps upload with 720p30 and 720p60 through 2160p60 formats. Each phase ran about
40 s. The speed was set through the YouTube player API (the same path as YouTube's speed menu).

| Phase | Shim | Rate | Picture | Player rate | Dropped / decoded frames |
|---|---|---|---|---|---|
| auto quality | off | 2 | **480p** | 2 | 0 / 2438 |
| manual 1080p | off | 2 | 1080p | **reset to 1** | 0 / 1821 |
| manual 1080p | on | 2 | **1080p** | 2 | 0 / 4842 (~120 decoded fps) |
| auto quality | on | 1.5 | **1080p** | 1.5 | 0 / 3626 |

Cobalt's raw answers on that TV (vp9, avc and av1 at 720p, 1080p, 1440p and 2160p) were true
for 30 and 60 fps and false for 75, 90 and 120 fps. avc above 1080p was false at every rate.

## Other changes in this fork

* A loopback-only local proxy (`standalone/service/local-proxy.js`) replaces upstream's
  standalone service.
  * It intercepts TLS only for `youtube.com` and `www.youtube.com`, to inject the pinned local
    userscript, whose SHA-256 is checked against `build.json`.
  * Other allow-listed Google hosts are tunnelled untouched. Upstream TLS is verified against
    Cobalt's own bundled roots, not against the local CA.
* SponsorBlock and DeArrow lookups, the self-updater and dynamic jsDelivr loading are disabled.
  The userscript makes no third-party queries.
* The speed menu is limited to a maximum of 2x.
* The DIAL name is `YouTube`, so casting from the phone YouTube app targets this widget.

## Preventing background pre-launch of native YouTube

The preinstalled YouTube widget (`9Ur5IzDKqV.TizenYouTube`) declares `prelaunch.support=true` in
`/opt/usr/apps/9Ur5IzDKqV/res/config.xml` and `/opt/dbspace/.pkgmgr_parser.db` (`package_app_app_metadata`),
which causes Tizen to pre-launch an unproxied Cobalt instance in the background at boot.
`tools/provision-on-tv.sh` automatically sets `prelaunch.support` to `false` (preserving a backup
of `config.xml`) so launching `TizenTubeS.TizenTube` always starts Cobalt with the local proxy.

## Developer measurement tool (optional)

`python3 tools/build.py --with-qa` adds `mods/features/rateCapQA.js`. It stays inert unless
the app data directory on the TV contains a short-lived `qa-enable.json`:

```json
{"clip":"<11-character YouTube video id>","expires":<unix ms, at most 15 min ahead>}
```

When enabled, it records Cobalt's raw `isTypeSupported` answers and per-phase playback metrics
to `qa-metrics.jsonl`. The proxy accepts only bounded numeric records. Delete the file afterwards.
