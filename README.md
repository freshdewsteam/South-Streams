# 🌊 South Streams

**South Streams** brings you the latest Malayalam and Tamil OTT movies and web series directly to Stremio and Nuvio.

> Automatically updated with new releases every day. 🎬

---

## ✨ What's Inside

| Catalog | What You'll Find |
|---------|------------------|
| 🎬 **Latest Malayalam Movies** | New Malayalam OTT film releases |
| 📺 **Latest Malayalam Series** | New Malayalam OTT web series |
| 🎬 **Latest Tamil Movies** | New Tamil OTT film releases |
| 📺 **Latest Tamil Series** | New Tamil OTT web series |

**Only titles already streaming on OTT are shown. No theatre releases, no future dates.**

---

## 📦 How to Install

### Stremio

1. Open Stremio
2. Go to **Addons** → **Community Addons**
3. Search for **"South Streams"**
4. Click **Install**

### Nuvio

1. Open Nuvio
2. Go to **Addons**
3. Search for **"South Streams"**
4. Click **Install**

### Manual Add-on URL
http://mollywood-addon.onrender.com/manifest.json

---

## 🔄 Updates

| When | What Happens |
|------|--------------|
| Every 6 hours | New releases are automatically added |
| Daily | Fresh content appears in your catalog |

**No manual updates needed.** Your addon updates itself.

---

## 🛠️ Maintainer notes

**Where things live**
- `main` — code, `overrides.json` and the workflow. Generated data is *not* committed here.
- `cache` branch — generated data only (`data/cache.json`, `data/unmatched.json`, lookup caches). Every build replaces it with a single fresh commit, so the repo doesn't grow.

**Missing or wrong title?**
1. Check [`data/unmatched.json` on the cache branch](https://github.com/freshdewsteam/South-Streams/blob/cache/data/unmatched.json) — it lists every title that couldn't be added, with the reason.
2. Fix it in [`overrides.json`](overrides.json) (pin a TMDB/IMDb ID, set an OTT date, add or hide a title). The next build applies it.

**Reliable schedule (cron-job.org)**
GitHub's built-in cron often runs hours late, so builds are triggered on time from [cron-job.org](https://cron-job.org) (free). GitHub's cron stays as a backup and skips itself if a build ran in the last 2.5 hours.
1. GitHub → Settings → Developer settings → Fine-grained tokens → **Generate new token**. Repository access: *only South-Streams*. Permissions: **Actions → Read and write**. Copy the token.
2. On cron-job.org create a job for each time — **00:01, 05:01, 10:01, 15:01, 18:01 UTC** (set the job's time zone to UTC):
   - URL: `https://api.github.com/repos/freshdewsteam/South-Streams/actions/workflows/update-cache.yml/dispatches`
   - Method: **POST**
   - Headers: `Authorization: Bearer <your token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`
   - Body: `{"ref":"main"}`
3. A successful call returns **204**. The 18:01 UTC run is the deep sweep. A manual run from the Actions tab can also force one ("deep" option).
4. Fine-grained tokens expire (max 1 year) — set a reminder to renew it.

---

## 📱 Quick Links

| Link | Purpose |
|------|---------|
| [GitHub Repository](https://github.com/freshdewsteam/Mollywood-addon) | Source code and issues |
| [Render Deployment](http://mollywood-addon.onrender.com/) | Addon status page |

---

## 📄 License

MIT License — free to use and modify.

---

**Made with ❤️ for South Indian cinema lovers.**
