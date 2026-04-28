# Looped Pomodoro Tab Switcher

A Manifest V3 browser extension for Chrome or Edge that rotates through a user-selected list of already-open tabs on a custom timer.

## How to load it

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click **Load unpacked**.
4. Select this folder:
   `C:\Users\OMNIARCH\Documents\Codex\2026-04-28\build-an-extension-which-is-pomodoro`

## How to use it

1. Open the extension popup.
2. Add tabs from **Open Tabs** into **Selected Loop**.
3. Set the minute value beside each selected tab.
4. Drag selected tabs to choose the loop order.
5. Click **Start**.

The popup shows the active tab, remaining countdown, completed tabs in the current loop, and progress bar while the loop is running. The selected tab rows also fill as the active tab's timer advances.

Use **Pause** to preserve the remaining time, **Resume** to continue, **Next** to switch immediately, and **Stop** to reset the loop. The notification toggle controls desktop notifications when the extension switches tabs.

Breaks are optional. Enable the default break timer to add a break between tabs, or set a custom break beside any selected tab. A custom break of `0` means the tab uses the enabled default break.

The **Focus Dashboard** stores local usage stats by day. It shows today's total, the last 7 days, session count, a GitHub-style 35-day heatmap, and the top tabs for whichever day you click. Smaller entries are grouped into **Other**, and **Clear list** removes tab listings for the selected day while keeping the heatmap total.

The extension only switches between existing tabs. It does not create new tabs, and it prevents duplicate tab entries in the loop. If a selected tab is closed, it is automatically removed from the saved loop.
