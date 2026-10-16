// YouTube 4K Video & Thumbnail Downloader Server
// Powered by Deno, yt-dlp & FFmpeg

// Zero-dependency path utilities
function extname(p: string): string {
  const lastDot = p.lastIndexOf(".");
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return (lastDot > lastSlash && lastDot !== -1) ? p.slice(lastDot) : "";
}

const isWindows = Deno.build.os === "windows";
const sep = isWindows ? "\\" : "/";
const pathSep = isWindows ? ";" : ":";

function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join(sep)
    .replace(/[/\\]+/g, sep);
}

function resolve(...parts: string[]): string {
  return join(...parts);
}

const PORT = Number(Deno.env.get("PORT")) || 5050;
const ROOT_DIR = Deno.cwd();
const BIN_DIR = join(ROOT_DIR, "bin");
const YTDLP_PATH = isWindows ? join(BIN_DIR, "yt-dlp.exe") : "yt-dlp";
const FFMPEG_PATH = isWindows ? join(BIN_DIR, "ffmpeg.exe") : "ffmpeg";
const DOWNLOADS_DIR = join(ROOT_DIR, "downloads");
const THUMBNAILS_DIR = join(DOWNLOADS_DIR, "thumbnails");

// Ensure directories exist
await Deno.mkdir(DOWNLOADS_DIR, { recursive: true });
await Deno.mkdir(THUMBNAILS_DIR, { recursive: true });

// Active download jobs in-memory
interface DownloadJob {
  id: string;
  url: string;
  title: string;
  quality: string;
  format: string;
  audioOnly: boolean;
  status: "starting" | "downloading" | "merging" | "completed" | "error";
  percent: number;
  speed: string;
  eta: string;
  totalSize: string;
  downloadedSize: string;
  filename: string;
  filePath: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const jobs = new Map<string, DownloadJob>();

// Auto-cleanup worker: Automatically delete files older than 20 minutes so disk space never fills up
setInterval(async () => {
  try {
    const now = Date.now();
    for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
      if (entry.isFile && !entry.name.endsWith(".json")) {
        const fullPath = join(DOWNLOADS_DIR, entry.name);
        try {
          const stat = await Deno.stat(fullPath);
          const mtime = stat.mtime ? stat.mtime.getTime() : now;
          if (now - mtime > 20 * 60 * 1000) { // 20 minutes old
            await Deno.remove(fullPath);
            console.log(`[AUTO-CLEANUP] Cleaned up temporary video: ${entry.name}`);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}, 3 * 60 * 1000); // Check every 3 minutes

// History storage in json
const HISTORY_FILE = join(ROOT_DIR, "downloads", "history.json");
async function loadHistory(): Promise<any[]> {
  try {
    const data = await Deno.readTextFile(HISTORY_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveHistory(entry: any) {
  try {
    const history = await loadHistory();
    // remove existing if same filename
    const filtered = history.filter((h) => h.filename !== entry.filename);
    filtered.unshift(entry);
    // keep last 50
    await Deno.writeTextFile(HISTORY_FILE, JSON.stringify(filtered.slice(0, 50), null, 2));
  } catch (err) {
    console.error("Error saving history:", err);
  }
}

// MIME types helper
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
};

// Request handler
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Enable CORS
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  try {
    // 1. API: Extract Video Information
    if (path === "/api/info" && req.method === "POST") {
      const body = await req.json();
      const videoUrl = body.url?.trim();

      if (!videoUrl) {
        return new Response(JSON.stringify({ error: "Please provide a valid YouTube URL" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      console.log(`[INFO] Extracting metadata for: ${videoUrl}`);

      const cmd = new Deno.Command(YTDLP_PATH, {
        args: [
          "--dump-json",
          "--no-playlist",
          "--no-warnings",
          ...(isWindows ? ["--ffmpeg-location", BIN_DIR] : []),
          videoUrl,
        ],
        env: {
          ...Deno.env.toObject(),
          PATH: `${BIN_DIR}${pathSep}${Deno.env.get("PATH") || ""}`,
        },
      });

      const { code, stdout, stderr } = await cmd.output();
      if (code !== 0) {
        const errorText = new TextDecoder().decode(stderr);
        console.error(`[ERROR] yt-dlp metadata failed:`, errorText);
        return new Response(
          JSON.stringify({
            error: "Failed to fetch video information. Ensure the URL is valid and publicly accessible.",
            details: errorText,
          }),
          { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const rawJson = new TextDecoder().decode(stdout);
      const data = JSON.parse(rawJson);

      // Process thumbnails with resolution ranking
      const processedThumbnails = (data.thumbnails || [])
        .map((t: any) => ({
          url: t.url,
          width: t.width || 0,
          height: t.height || 0,
          resolution: t.width && t.height ? `${t.width}x${t.height}` : "Standard",
          id: t.id || "",
        }))
        .filter((t: any) => t.url && !t.url.endsWith(".webp?sqp="))
        .sort((a: any, b: any) => (b.width * b.height) - (a.width * a.height));

      // Ensure maxresdefault is included for YouTube videos
      const videoId = data.id;
      if (videoId) {
        const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
        const hqdefault = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        const mqdefault = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

        if (!processedThumbnails.some((t: any) => t.url.includes("maxresdefault"))) {
          processedThumbnails.unshift({
            url: maxres,
            width: 1920,
            height: 1080,
            resolution: "1920x1080 (Ultra HD MaxRes)",
            id: "maxresdefault",
          });
        }
      }

      // Detect available resolutions (4K, 1440p, 1080p, 720p, 480p, 360p)
      const heights = new Set<number>();
      for (const f of data.formats || []) {
        if (f.height) heights.add(f.height);
      }

      const availableQualities: {
        id: string;
        label: string;
        badge: string;
        height: number;
        available: boolean;
        fps?: number;
      }[] = [
        {
          id: "4k",
          label: "4K Ultra HD (2160p)",
          badge: "4K UHD",
          height: 2160,
          available: Array.from(heights).some((h) => h >= 2160),
        },
        {
          id: "1440p",
          label: "2K Quad HD (1440p)",
          badge: "2K QHD",
          height: 1440,
          available: Array.from(heights).some((h) => h >= 1440),
        },
        {
          id: "1080p",
          label: "Full HD (1080p)",
          badge: "1080p FHD",
          height: 1080,
          available: Array.from(heights).some((h) => h >= 1080),
        },
        {
          id: "720p",
          label: "HD (720p)",
          badge: "720p HD",
          height: 720,
          available: Array.from(heights).some((h) => h >= 720),
        },
        {
          id: "480p",
          label: "Standard (480p)",
          badge: "480p SD",
          height: 480,
          available: Array.from(heights).some((h) => h >= 480),
        },
        {
          id: "360p",
          label: "Low (360p)",
          badge: "360p",
          height: 360,
          available: Array.from(heights).some((h) => h >= 360),
        },
      ];

      const bestThumbnail = processedThumbnails[0]?.url || data.thumbnail || `https://i.ytimg.com/vi/${data.id}/maxresdefault.jpg`;

      const responsePayload = {
        id: data.id,
        title: data.title,
        uploader: data.uploader || data.channel,
        uploader_url: data.uploader_url || data.channel_url,
        duration: data.duration,
        duration_string: data.duration_string || formatDuration(data.duration),
        view_count: data.view_count,
        upload_date: data.upload_date,
        description: data.description ? data.description.slice(0, 300) : "",
        thumbnail: bestThumbnail,
        thumbnails: processedThumbnails.slice(0, 8),
        qualities: availableQualities,
        has4k: availableQualities[0].available,
      };

      return new Response(JSON.stringify(responsePayload), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // 2. API: Start Download Job
    if (path === "/api/download" && req.method === "POST") {
      const body = await req.json();
      const { url: videoUrl, quality = "4k", format = "mp4", audioOnly = false, title = "video" } = body;

      if (!videoUrl) {
        return new Response(JSON.stringify({ error: "Missing video URL" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);

      const job: DownloadJob = {
        id: jobId,
        url: videoUrl,
        title,
        quality,
        format,
        audioOnly,
        status: "starting",
        percent: 0,
        speed: "0 MB/s",
        eta: "Starting...",
        totalSize: "--",
        downloadedSize: "--",
        filename: "",
        filePath: "",
        startedAt: Date.now(),
      };

      jobs.set(jobId, job);

      // Start asynchronous download process
      startDownloadProcess(job);

      return new Response(JSON.stringify({ jobId, status: "started" }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // 3. API: Check Job Progress
    if (path.startsWith("/api/progress/")) {
      const jobId = path.replace("/api/progress/", "");
      const job = jobs.get(jobId);

      if (!job) {
        return new Response(JSON.stringify({ error: "Job not found" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(job), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // 4. API: Download Thumbnail
    if (path === "/api/download-thumbnail" && req.method === "POST") {
      const body = await req.json();
      const { thumbnailUrl, title = "thumbnail", videoId, quality = "maxres" } = body;

      if (!thumbnailUrl && !videoId) {
        return new Response(JSON.stringify({ error: "Missing thumbnail URL or video ID" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      let fetchUrl = thumbnailUrl;
      if (!fetchUrl && videoId) {
        fetchUrl = quality === "maxres"
          ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
          : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }

      console.log(`[THUMBNAIL] Downloading thumbnail from: ${fetchUrl}`);

      try {
        let resp = await fetch(fetchUrl);
        // If maxres fails with 404, fallback to hqdefault
        if (!resp.ok && videoId && fetchUrl.includes("maxresdefault")) {
          fetchUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
          resp = await fetch(fetchUrl);
        }

        if (!resp.ok) {
          throw new Error(`Failed to fetch thumbnail: HTTP ${resp.status}`);
        }

        const buffer = await resp.arrayBuffer();
        const safeTitle = sanitizeFilename(title).slice(0, 50);
        const filename = `${safeTitle}_thumbnail_${quality}.jpg`;
        const savePath = join(THUMBNAILS_DIR, filename);

        await Deno.writeFile(savePath, new Uint8Array(buffer));

        // Save to history
        await saveHistory({
          type: "thumbnail",
          title,
          filename,
          filePath: savePath,
          size: formatBytes(buffer.byteLength),
          downloadedAt: new Date().toISOString(),
          previewUrl: `/api/preview/thumbnail/${encodeURIComponent(filename)}`,
        });

        return new Response(
          JSON.stringify({
            success: true,
            filename,
            filePath: savePath,
            size: formatBytes(buffer.byteLength),
            previewUrl: `/api/preview/thumbnail/${encodeURIComponent(filename)}`,
          }),
          { headers: { ...headers, "Content-Type": "application/json" } },
        );
      } catch (err: any) {
        console.error("[ERROR] Thumbnail download error:", err);
        return new Response(
          JSON.stringify({ error: "Failed to download thumbnail: " + err.message }),
          { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }
    }

    // 5. API: Serve Thumbnail Preview Image
    if (path.startsWith("/api/preview/thumbnail/")) {
      const filename = decodeURIComponent(path.replace("/api/preview/thumbnail/", ""));
      const filePath = join(THUMBNAILS_DIR, filename);

      try {
        const file = await Deno.readFile(filePath);
        return new Response(file, {
          headers: { ...headers, "Content-Type": "image/jpeg" },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    // 6. API: Get Downloads History
    if (path === "/api/history" && req.method === "GET") {
      const history = await loadHistory();
      return new Response(JSON.stringify(history), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // 7. API: Open Folder in Windows Explorer
    if (path === "/api/open-folder" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const folderToOpen = body.type === "thumbnails" ? THUMBNAILS_DIR : DOWNLOADS_DIR;

      const p = new Deno.Command("explorer.exe", {
        args: [folderToOpen],
      });
      p.spawn();

      return new Response(JSON.stringify({ success: true, folder: folderToOpen }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // 8. API: Play / Open File
    if (path === "/api/play-file" && req.method === "POST") {
      const body = await req.json();
      const filePath = body.filePath;

      if (filePath) {
        const p = new Deno.Command("cmd.exe", {
          args: ["/c", "start", '""', filePath],
        });
        p.spawn();
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // 9. API: System Info & Diagnostics
    if (path === "/api/diagnostics") {
      const hasYtdlp = await fileExists(YTDLP_PATH);
      const hasFfmpeg = await fileExists(FFMPEG_PATH);
      return new Response(
        JSON.stringify({
          status: "ready",
          ytDlp: hasYtdlp,
          ffmpeg: hasFfmpeg,
          downloadsDir: DOWNLOADS_DIR,
          port: PORT,
        }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // 10. API: Direct Browser File Download to User's PC
    if (path === "/api/file/download" && (req.method === "GET" || req.method === "HEAD")) {
      const jobId = url.searchParams.get("jobId");
      const filenameParam = url.searchParams.get("filename");
      let targetPath = "";
      let targetName = "";

      if (jobId) {
        const job = jobs.get(jobId);
        if (job && job.filePath) {
          targetPath = job.filePath;
          targetName = job.filename || targetPath.split(/[/\\]/).pop() || "video.mp4";
        }
      }

      if (!targetPath && filenameParam) {
        const safeName = filenameParam.replace(/^.*[\\\/]/, "");
        targetPath = join(DOWNLOADS_DIR, safeName);
        targetName = safeName;
      }

      try {
        const stat = await Deno.stat(targetPath);
        if (!stat.isFile) throw new Error("File not found");

        // Clean filename so Windows has a clean standard extension without stream tags
        let cleanDownloadName = targetName.replace(/\.f\d+\./g, ".");
        if (!cleanDownloadName.match(/\.(mp4|mkv|mp3|webm|jpg|png)$/i)) {
          cleanDownloadName += ".mp4";
        }
        cleanDownloadName = sanitizeFilename(cleanDownloadName);

        const ext = extname(cleanDownloadName).toLowerCase();
        const contentType = MIME_TYPES[ext] || "video/mp4";
        const asciiFilename = cleanDownloadName.replace(/[^\x20-\x7E]/g, "_");
        const encodedFilename = encodeURIComponent(cleanDownloadName);

        const dlHeaders = {
          ...headers,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
          "Content-Length": stat.size.toString(),
          "Cache-Control": "no-cache",
        };

        if (req.method === "HEAD") {
          return new Response(null, { headers: dlHeaders });
        }

        const file = await Deno.open(targetPath, { read: true });
        return new Response(file.readable, { headers: dlHeaders });
      } catch (err: any) {
        console.error("[ERROR] File download error:", err);
        return new Response(JSON.stringify({ error: "File not found or not ready yet" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }

    // 11. API: Direct Browser Thumbnail Download
    if (path === "/api/thumbnail/download" && (req.method === "GET" || req.method === "HEAD")) {
      const videoId = url.searchParams.get("videoId");
      const quality = url.searchParams.get("quality") || "maxres";
      const title = url.searchParams.get("title") || "thumbnail";

      let fetchUrl = quality === "maxres"
        ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      try {
        let resp = await fetch(fetchUrl);
        if (!resp.ok && videoId && fetchUrl.includes("maxresdefault")) {
          fetchUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
          resp = await fetch(fetchUrl);
        }
        if (!resp.ok) throw new Error("Thumbnail not found on YouTube");

        const safeTitle = sanitizeFilename(title).slice(0, 50);
        const downloadName = `${safeTitle}_thumbnail_${quality}.jpg`;
        const asciiName = downloadName.replace(/[^\x20-\x7E]/g, "_");
        const encodedName = encodeURIComponent(downloadName);

        return new Response(resp.body, {
          headers: {
            ...headers,
            "Content-Type": "image/jpeg",
            "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
          },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }

    // Static Files Handling (Frontend)
    let filePath = path === "/" ? "/index.html" : path;
    const resolvedPath = join(ROOT_DIR, "public", filePath);

    try {
      const stat = await Deno.stat(resolvedPath);
      if (stat.isFile) {
        const content = await Deno.readFile(resolvedPath);
        const ext = extname(resolvedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        return new Response(content, {
          headers: { ...headers, "Content-Type": contentType },
        });
      }
    } catch {
      // Return index.html for SPA if not found
      try {
        const fallback = await Deno.readFile(join(ROOT_DIR, "public", "index.html"));
        return new Response(fallback, {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    return new Response("Not Found", { status: 404 });
  } catch (err: any) {
    console.error("[SERVER ERROR]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

// Background download execution
async function startDownloadProcess(job: DownloadJob) {
  try {
    const args: string[] = [
      "--newline",
      "--no-playlist",
      "--no-part",
      "--ffmpeg-location",
      BIN_DIR,
    ];

    const tempId = `temp_${job.id}`;
    if (job.audioOnly) {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
      args.push("-o", join(DOWNLOADS_DIR, `${tempId}.%(ext)s`));
    } else {
      // Prioritize universal H.264 (AVC) and VP9 codecs to completely prevent "AV1 Video Extension" errors on Windows
      function getCompatibleFormat(height: number): string {
        return [
          `bestvideo[height<=${height}][vcodec^=avc]+bestaudio[acodec^=mp4a]`,
          `bestvideo[height<=${height}][vcodec^=avc]+bestaudio`,
          `bestvideo[height<=${height}][vcodec^=vp9]+bestaudio[acodec^=mp4a]`,
          `bestvideo[height<=${height}][vcodec^=vp9]+bestaudio`,
          `bestvideo[height<=${height}][vcodec!*='av01']+bestaudio`,
          `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,
        ].join("/");
      }

      let formatFilter = getCompatibleFormat(2160);
      if (job.quality === "4k") {
        formatFilter = getCompatibleFormat(2160);
      } else if (job.quality === "1440p") {
        formatFilter = getCompatibleFormat(1440);
      } else if (job.quality === "1080p") {
        formatFilter = getCompatibleFormat(1080);
      } else if (job.quality === "720p") {
        formatFilter = getCompatibleFormat(720);
      } else if (job.quality === "480p") {
        formatFilter = getCompatibleFormat(480);
      } else if (job.quality === "360p") {
        formatFilter = getCompatibleFormat(360);
      }

      args.push("-f", formatFilter);
      args.push("--merge-output-format", "mp4");
      args.push("-o", join(DOWNLOADS_DIR, `${tempId}.%(ext)s`));
    }

    args.push("--windows-filenames");
    args.push(job.url);

    console.log(`[JOB ${job.id}] Executing yt-dlp with quality: ${job.quality}`);

    const cmd = new Deno.Command(YTDLP_PATH, {
      args,
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        PATH: `${BIN_DIR}${pathSep}${Deno.env.get("PATH") || ""}`,
      },
    });

    const child = cmd.spawn();
    job.status = "downloading";
    job.percent = 1; // Immediately show activity

    // Read stdout & stderr streams
    const decoder = new TextDecoder();
    const stdoutReader = child.stdout.getReader();
    const stderrReader = child.stderr.getReader();

    let finalFilename = "";
    let stdoutBuffer = "";
    let streamPhase = 1; // 1 = video stream, 2 = audio stream
    let hasSeenFirstDest = false;

    // Read stderr concurrently to prevent pipe buffer blocks
    (async () => {
      try {
        while (true) {
          const { done } = await stderrReader.read();
          if (done) break;
        }
      } catch (_) {}
    })();

    // Read stdout stream with carriage-return (\r) and newline (\n) handling
    (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value, { stream: true });
          
          // CRITICAL FIX: Split by [\r\n]+ because yt-dlp prints progress with \r!
          const chunks = stdoutBuffer.split(/[\r\n]+/);
          stdoutBuffer = chunks.pop() || "";

          for (const line of chunks) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // 1. Detect transition between video and audio stream
            if (trimmed.includes("[download] Destination:")) {
              const dest = trimmed.replace("[download] Destination:", "").trim();
              if (hasSeenFirstDest) {
                streamPhase = 2; // Moving to audio stream
              }
              hasSeenFirstDest = true;
              if (!dest.match(/\.f\d+\./)) {
                finalFilename = dest;
              }
            }

            // 2. Parse standard yt-dlp progress:
            // e.g.: [download]  54.4% of ~ 18.31MiB at   7.97MiB/s ETA 00:01
            // or:   [download] 100% of   18.31MiB in 00:00:02 at 7.13MiB/s
            const standardMatch = trimmed.match(/\[download\]\s+([\d\.]+)%\s+of\s+~?\s*([^\s]+)(?:\s+(?:at|in)\s+([^\s]+))?(?:\s+(?:ETA|at)\s+([^\s]+))?/i);
            if (standardMatch) {
              const rawPercent = parseFloat(standardMatch[1]);
              const sizeStr = standardMatch[2];
              const p3 = standardMatch[3] || "";
              const p4 = standardMatch[4] || "";

              let speed = "";
              let eta = "";

              if (p3.includes("/s")) {
                speed = p3;
                eta = p4;
              } else if (p4.includes("/s")) {
                speed = p4;
                eta = p3;
              } else {
                speed = p3;
                eta = p4;
              }

              if (speed && speed !== "Unknown" && !speed.includes("00:")) {
                job.speed = speed;
              }
              if (eta && eta !== "Unknown") {
                job.eta = eta;
              }
              if (sizeStr && sizeStr !== "Unknown" && sizeStr !== "Unknown B") {
                job.totalSize = sizeStr;
              }

              if (!isNaN(rawPercent)) {
                if (job.audioOnly) {
                  // Single audio stream: 0% to 95%
                  const mapped = parseFloat((rawPercent * 0.95).toFixed(1));
                  job.percent = Math.min(95, Math.max(job.percent, mapped));
                } else {
                  // Multi-stream: Stream 1 (Video) = 1% to 75%, Stream 2 (Audio) = 75% to 95%
                  if (streamPhase === 1) {
                    const mapped = parseFloat((rawPercent * 0.75).toFixed(1));
                    job.percent = Math.min(75, Math.max(job.percent, mapped));
                  } else {
                    const mapped = parseFloat((75 + (rawPercent * 0.20)).toFixed(1));
                    job.percent = Math.min(95, Math.max(job.percent, mapped));
                  }
                }

                // Calculate downloaded size estimate if total size is known
                if (job.totalSize && job.totalSize !== "--") {
                  job.downloadedSize = `${(job.percent).toFixed(0)}% of ${job.totalSize}`;
                }
              }
            }

            // 3. Merger phase detection
            if (trimmed.includes("[Merger]") || trimmed.includes("Merging formats into")) {
              job.status = "merging";
              job.eta = "Merging audio & 4K video...";
              job.percent = 98;
              const match = trimmed.match(/"([^"]+)"/);
              if (match) finalFilename = match[1];
            } else if (trimmed.includes("has already been downloaded")) {
              job.percent = 100;
              job.status = "completed";
            }
          }
        }
      } catch (err) {
        console.error("Error reading stdout:", err);
      }
    })();

    const status = await child.status;

    // Give Windows file system / Defender a moment to release file handles
    await new Promise((r) => setTimeout(r, 600));

    // Discover what files were created
    let videoStreamFile = "";
    let audioStreamFile = "";
    let mergedDirectFile = "";

    try {
      for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
        if (!entry.isFile || !entry.name.startsWith(tempId)) continue;
        const fullP = join(DOWNLOADS_DIR, entry.name);
        if (entry.name.endsWith(".temp.mp4") || entry.name.endsWith(".mp4") || entry.name.endsWith(".mp3")) {
          mergedDirectFile = fullP;
        } else if (entry.name.match(/\.f\d+\.(mp4|webm)$/) && !entry.name.match(/\.f(251|140|249|250)\./)) {
          videoStreamFile = fullP;
        } else if (entry.name.match(/\.f(251|140|249|250|\d+)\.(webm|m4a)$/)) {
          audioStreamFile = fullP;
        }
      }
    } catch (_) {}

    const cleanExtension = job.audioOnly ? ".mp3" : ".mp4";
    const cleanBaseName = `${sanitizeFilename(job.title)} [${job.quality.toUpperCase()}]${cleanExtension}`;
    const finalCleanPath = join(DOWNLOADS_DIR, cleanBaseName);

    // If a merged file was produced (or streams exist), treat as success!
    if (status.code === 0 || mergedDirectFile || (videoStreamFile && audioStreamFile)) {
      job.percent = 100;
      job.status = "completed";
      job.eta = "Finished!";
      job.completedAt = Date.now();

      if (mergedDirectFile) {
        // Retry rename with backoff if Windows file system temporarily locked the file
        let renamed = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          try {
            try { await Deno.remove(finalCleanPath); } catch (_) {}
            await Deno.rename(mergedDirectFile, finalCleanPath);
            job.filePath = finalCleanPath;
            job.filename = cleanBaseName;
            renamed = true;
            break;
          } catch (_) {
            await new Promise((r) => setTimeout(r, 350));
          }
        }
        if (!renamed) {
          try {
            await Deno.copyFile(mergedDirectFile, finalCleanPath);
            try { await Deno.remove(mergedDirectFile); } catch (_) {}
            job.filePath = finalCleanPath;
            job.filename = cleanBaseName;
            renamed = true;
          } catch (_) {
            job.filePath = mergedDirectFile;
            job.filename = cleanBaseName;
          }
        }
        if (videoStreamFile) { try { await Deno.remove(videoStreamFile); } catch (_) {} }
        if (audioStreamFile) { try { await Deno.remove(audioStreamFile); } catch (_) {} }
      } else if (videoStreamFile && audioStreamFile) {
        console.log(`[FFMPEG] Merging separated streams into clean MP4: ${cleanBaseName}`);
        job.status = "merging";
        const mergeCmd = new Deno.Command(FFMPEG_PATH, {
          args: [
            "-i", videoStreamFile,
            "-i", audioStreamFile,
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-y",
            finalCleanPath,
          ],
        });
        const mResult = await mergeCmd.output();
        if (mResult.code === 0) {
          try { await Deno.remove(videoStreamFile); } catch (_) {}
          try { await Deno.remove(audioStreamFile); } catch (_) {}
          job.filePath = finalCleanPath;
          job.filename = cleanBaseName;
          job.status = "completed";
        } else {
          console.error("[FFMPEG ERROR] Manual merge failed:", new TextDecoder().decode(mResult.stderr));
          try { await Deno.remove(finalCleanPath); } catch (_) {}
          try {
            await Deno.rename(videoStreamFile, finalCleanPath);
            job.filePath = finalCleanPath;
          } catch (_) {
            job.filePath = videoStreamFile;
          }
          job.filename = cleanBaseName;
          job.status = "completed";
        }
      } else if (videoStreamFile && !audioStreamFile) {
        try {
          try { await Deno.remove(finalCleanPath); } catch (_) {}
          await Deno.rename(videoStreamFile, finalCleanPath);
          job.filePath = finalCleanPath;
          job.filename = cleanBaseName;
        } catch (_) {
          job.filePath = videoStreamFile;
          job.filename = cleanBaseName;
        }
      } else {
        job.filename = cleanBaseName;
        job.filePath = finalCleanPath;
      }

      // Add to history
      await saveHistory({
        type: job.audioOnly ? "audio" : "video",
        title: job.title,
        quality: job.quality,
        format: job.format,
        filename: job.filename,
        filePath: job.filePath,
        totalSize: job.totalSize,
        downloadedAt: new Date().toISOString(),
      });

      console.log(`[JOB ${job.id}] Successfully finished: ${job.filename}`);
    } else {
      const errOutput = await child.stderr.getReader().read();
      const errorMsg = decoder.decode(errOutput.value || new Uint8Array());
      job.status = "error";
      job.error = errorMsg.slice(0, 300) || "Download encountered an error";
      console.error(`[JOB ${job.id}] Failed with exit code ${status.code}:`, job.error);
    }
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    console.error(`[JOB ${job.id}] Unexpected error:`, err);
  }
}

// Helpers
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDuration(seconds: number): string {
  if (!seconds) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) {
    return `${hrs}:${(mins % 60).toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// Start Server
console.log(`=====================================================`);
console.log(`🚀 YouTube 4K & Thumbnail Downloader is running!`);
console.log(`🌐 Local Web UI: http://localhost:${PORT}`);
console.log(`📁 Downloads folder: ${DOWNLOADS_DIR}`);
console.log(`=====================================================`);

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, handleRequest);
