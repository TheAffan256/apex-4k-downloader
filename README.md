# 🎥 Apex 4K YouTube Video & Thumbnail Studio

An ultra-modern, high-performance **YouTube Video & Ultra-HD Thumbnail Downloader** for Windows that downloads pristine **4K UHD (2160p 60fps HDR)** videos, extracts crystal-clear MP3 320kbps audio, and grabs full-resolution YouTube thumbnails with 1-click.

---

## ✨ Features

- **Pristine 4K UHD (2160p) Downloads**: Merges YouTube's highest quality 4K video stream with high-bitrate audio streams seamlessly using built-in **FFmpeg**.
- **Multi-Resolution Selector**: Download in **4K (2160p)**, **2K (1440p)**, **1080p (FHD)**, **720p (HD)**, **480p/360p**, or **MP3 Audio Only (320kbps)**.
- **Dedicated Thumbnail Download Studio**:
  - Automatically fetches the uncompressed **MaxRes (1920x1080 / 4K)** thumbnail.
  - Interactive thumbnail preview with full-screen zoom inspect modal.
  - 1-click **Direct Browser Download** as high-quality image.
  - 1-click **Save to Local Folder** (`downloads/thumbnails/`).
- **Live Real-Time Download Monitor**:
  - Live animated gradient progress bar.
  - Real-time download speed (`MB/s`), time remaining (`ETA`), and downloaded vs total bytes.
  - Stage notifications (`Downloading Streams` ➔ `FFmpeg 4K Muxing` ➔ `Completed`).
- **Windows System Integration**:
  - **Open Folder** button opens `downloads\` directly in Windows File Explorer.
  - **Play Video** button launches completed downloads directly in your default media player.
  - Download History drawer keeping track of all completed files.
- **100% Portable & Self-Contained**:
  - Requires **NO** external Python, Node.js, or FFmpeg installations on your PC.
  - Includes pre-packaged 64-bit `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `deno.exe`.

---

## 🚀 How to Run

### Method 1: Double-Click Launcher (Easiest)
Simply double-click:
```
Launch-Downloader.bat
```
Your default web browser will automatically open:
```
http://localhost:5050
```

### Method 2: PowerShell
Run inside PowerShell:
```powershell
.\run.ps1
```

---

## 📁 Project Structure

```
yt video downloader/
├── bin/
│   ├── deno.exe          # High-speed web server & JS runtime
│   ├── ffmpeg.exe        # 4K video & audio stream merger
│   ├── ffprobe.exe       # Media analyzer
│   └── yt-dlp.exe        # YouTube downloader engine
├── downloads/            # Default video output folder
│   └── thumbnails/       # Downloaded thumbnails folder
├── public/               # Modern Glassmorphic Web UI
│   ├── index.html        # App structure
│   ├── styles.css        # Premium dark-mode design system
│   └── app.js            # Real-time client controller
├── server.ts             # Backend REST API server
├── Launch-Downloader.bat  # 1-click Windows launcher
├── run.ps1               # PowerShell launcher
└── README.md
```

---

## 🛠️ Diagnostics & Verification
To test the environment or run manually:
```powershell
.\bin\deno.exe run --allow-net --allow-run --allow-read --allow-write server.ts
```
