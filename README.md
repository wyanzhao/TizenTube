# ▶️ TizenTube (1080p60 High-Framerate Playback Speed Fork)

> [!NOTE]
> **This is a hardened standalone fork of [reisxd/TizenTube](https://github.com/reisxd/TizenTube)** focused on fixing a core Samsung Tizen Cobalt issue: on Samsung TVs using the built-in Cobalt YouTube player, setting playback speed to anything above 1x (`1.25x`, `1.5x`, `2x`) drops 60 fps videos to 480p.
>
> This fork resolves the root cause in `MediaSource.isTypeSupported` (see [docs/RATE_CAP_FIX.md](./docs/RATE_CAP_FIX.md)) and has been verified on a Samsung QN90A (2021, Tizen 6.0) playing 1080p60 at `1.5x` and `2x` with zero dropped frames.
>
> **Key differences from upstream:**
> - **Standalone widget (`TizenTubeS.TizenTube`)** with a **loopback-only local TLS proxy** (`standalone/service/local-proxy.js`).
> - **Zero third-party telemetry or external lookups**: SponsorBlock, DeArrow, dynamic jsDelivr scripts, and the self-updater are disabled.
> - **Automatic native YouTube prelaunch suppression**: `tools/provision-on-tv.sh` disables `prelaunch.support` on the preinstalled YouTube app (`9Ur5IzDKqV`) so launching TizenTube never resumes an unproxied background Cobalt instance.
>
> **Requirements:** The widget must be signed with your own Tizen/Samsung certificate profile, and the one-time provisioning script ([tools/provision-on-tv.sh](./tools/provision-on-tv.sh)) requires root on the TV.
>
> ```sh
> python3 tools/build.py                          # build, pin script hash, run tests, stage build/wgt
> tizen package -t wgt -s <your-profile> -- build/wgt
> # install the signed .wgt (e.g. sdb shell 0 vd_appinstall TizenTubeS.TizenTube <path>), then as root on the TV:
> # PKG=TizenTubeS sh tools/provision-on-tv.sh
> ```
>
> Upstream documentation follows below for reference.

<p align="center">
    <img width="600px" src=".github/assets/TizenTube Standalone Banner.png">
    <br>
    <sub> TizenTube logo, banner and README by <a href="https://github.com/Zyborg777">@Zyborg777</a> </sub>
</p>

**TizenTube** is a TizenBrew module that enhances your favourite streaming websites viewing experience by removing ads and adding support for Sponsorblock. **Now works as a standalone app!**

** **
🤖 **Looking for an app for Android TVs?** Check out [TizenTube Cobalt](https://github.com/reisxd/TizenTubeCobalt). It offers everything TizenTube has for Android TVs.


<p align="left">
    <a href="https://github.com/reisxd/TizenTubeCobalt/releases/latest">
        <picture>
            <img width="250px"
                src=".github/assets/TizenTube_Cobalt_dl-button.png" />
        </picture>
    </a>
</p>

## ❓ How to install

Follow the guide in the [Installation Guide](./docs/README.md).

## ✨ Features
- 📺 **Picture-in-Picture Mode**
- 🛑 **Ad Blocker**: Enjoy your favourite streaming website without interruptions from ads.
- ❗ **SponsorBlock Support**: Automatically skip sponsored segments in videos.
- ⏭️ **Video Speed Control**: Adjust playback speed to your preference.
- 🔺 **[DeArrow](https://dearrow.ajay.app/) Support**: Remove clickbait and misleading video titles.
- ➕ **More to come!** Request features via [issues](https://github.com/reisxd/TizenTube/issues/new).

## 🌐 Community and Support 
| Links |
| ------------- |
| [r/TizenTube Subreddit](https://www.reddit.com/r/TizenTube/)  |
| [Discord Server](https://discord.gg/m2P7v8Y2qR)  | 
| [Telegram](https://t.me/tizentubeofficial)  |
| [Matrix Space](https://matrix.to/#/!BLE5ubNYktI30e8K0j:matrix.6513006.xyz)  |
| [Report Issues / Request Features](https://github.com/reisxd/TizenTube/issues)  |
