# 🎬 Mollywood & Kollywood OTT — Stremio Addon

A Stremio addon that shows **Malayalam and Tamil OTT releases** sourced from [91mobiles.com/entertainment](https://www.91mobiles.com/entertainment).

- ✅ Filters out BookMyShow / theatre-only listings automatically
- ✅ Two separate catalogues: Malayalam 🌴 and Tamil 🎭
- ✅ Movies and Web Series, each as their own catalogue
- ✅ Free to host on Render.com

---

## 📋 What You'll Get in Stremio

After installing, you'll see 4 new catalogues on your Stremio home screen:

| Catalogue | What it shows |
|---|---|
| 🌴 Malayalam OTT Movies | New Malayalam movies on streaming platforms |
| 🌴 Malayalam OTT Series | New Malayalam web series |
| 🎭 Tamil OTT Movies | New Tamil movies on streaming platforms |
| 🎭 Tamil OTT Series | New Tamil web series |

---

## 🚀 Step-by-Step: Deploy for Free on Render.com

### Step 1 — Create a GitHub Account (if you don't have one)
1. Go to github.com → click Sign up
2. Choose a username, email, and password → verify your email

### Step 2 — Put This Code on GitHub
1. Go to github.com/new
2. Repository name: mollywood-stremio-addon
3. Set it to **Public** so others can benefit too!
4. Click **Create repository**
5. Click **uploading an existing file**
6. Drag and drop ALL the files from this folder
7. Click **Commit changes**

### Step 3 — Deploy on Render.com
1. Go to render.com → Sign up with GitHub
2. Click **New +** → **Web Service**
3. Connect your GitHub repo mollywood-stremio-addon
4. Render auto-detects the render.yaml — click **Create Web Service**
5. Wait ~5 minutes for the first deploy
6. You get a URL like: https://mollywood-stremio-addon.onrender.com

### Step 4 — Install in Stremio
1. Open Stremio → click the puzzle icon (Addons)
2. Click **Community Addons** → paste your Render URL + /manifest.json
3. Example: https://mollywood-stremio-addon.onrender.com/manifest.json
4. Click Install — done! 🎉

---

## ⚠️ Important Notes

**Free Render Tier — Cold Starts:**
Render free tier spins down after 15 minutes idle. First load after idle takes ~30-60s.
Use UptimeRobot (free) to ping your URL every 10 minutes to keep it alive.

**No Streams Included:**
This addon only provides a catalogue (movie list). You need a stream addon like
Torrentio + your debrid service for actual playback — which you likely already have!

**Scraping Note:**
Scrapes publicly visible data from 91mobiles.com. If their site layout changes,
open a GitHub Issue and the scraper can be updated.

---

## 🛠️ Running Locally

```bash
# Install Node.js from nodejs.org (LTS version)
# Open terminal in this folder, then:
npm install
npm start
# Install in Stremio: http://localhost:7000/manifest.json
```

---

## 🤝 Contributing

Want to add Kannada, Telugu, or other languages? Open a Pull Request!

## 📄 License
MIT — Free to use, share, and modify.
