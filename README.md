# Sticky Repeat for Spicetify

Keep your selected Spotify repeat mode when you switch tracks, including **repeat one**.

[Русская инструкция](README.ru.md)

Spotify can reset repeat one when you skip to another song. Sticky Repeat remembers your choice and restores it on the next track. Switching repeat off using Spotify's normal repeat button updates the remembered choice too.

## Use

- A green **lock button** next to Spotify's repeat control means Sticky Repeat is enabled.
- Choose off, repeat context, or repeat one using Spotify's usual repeat button.
- Change tracks normally. The selected mode is restored automatically.
- Click the lock to disable the extension, or use the profile-menu toggle **«Сохранять режим повтора»**.

The toggle is enabled by default and saved between Spotify sessions. On startup, the extension adopts Spotify's current repeat mode. The interface labels are currently in Russian.

## Install

1. Install [Spicetify](https://spicetify.app/docs/getting-started).
2. Download [sticky-repeat.js](https://raw.githubusercontent.com/lonagi/spicetify-sticky-repeat/main/sticky-repeat.js) and put it in Spicetify's `Extensions` folder. On a standard macOS installation this is `~/.config/spicetify/Extensions/`. Run `spicetify -c` to locate your configuration file; the `Extensions` folder is beside it.
3. Enable the extension and apply the changes:

   ```sh
   spicetify config extensions sticky-repeat.js
   spicetify apply
   ```

If the macOS installer has not added Spicetify to your PATH, replace `spicetify` in these commands with `~/.spicetify/spicetify`. Applying changes restarts Spotify.

## Remove

```sh
spicetify config extensions sticky-repeat.js-
spicetify apply
```

## Compatibility

Verified on macOS with **Spotify 1.3.8.620** and **Spicetify 2.46.4**. The repeat-one → next-track flow, manual repeat-off, lock toggle, and restart persistence were checked in the desktop app. Other operating systems have not been tested.

Music tracks and local files are supported. Ads and podcasts are skipped. The extension uses Spicetify and internal player events, so Spotify or Spicetify updates may require changes. After a Spotify update, follow [Spicetify's update instructions](https://spicetify.app/docs/faq); normally this includes `spicetify backup apply`.

During the short track-transition window, repeat changes from another device or the native macOS menu may be indistinguishable from Spotify's automatic reset. Direct clicks on the repeat button in Spotify's window are explicitly handled.

Restoration uses a bounded retry window of 3.6 seconds. A late response to an obsolete request can start a new bounded correction window to respect the latest local choice.

## Privacy

The extension has no direct network requests, analytics, tokens, or external dependencies. It uses Spotify's existing player API. It stores only its enabled/disabled preference in Spotify's local storage.

## Development

No build step or package installation is needed. Use Node.js 22 or newer:

```sh
npm run check
npm test
```

The 20 tests cover transitions, fast skipping, repeat-off, delayed responses, restrictions, disabled mode, browser startup, and button remounting. Automated tests use a simulated player; the desktop checks above were performed separately.

This is an unofficial extension, not affiliated with Spotify or Spicetify.
