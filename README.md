# South Dakota Health Outcomes

A standalone dashboard of South Dakota health outcomes, built from Department of Health reports by the
DOH Report Pipeline. Same setup as South Dakota Pathways: HTML, CSS, and JavaScript, no build step, no libraries.

**This build is an unreviewed preview.** It shows a banner saying so. Keep the repository private, and don't
turn on GitHub Pages, until the Department of Health has reviewed the figures. To publish approved figures only,
rebuild with `python -m pipeline.cli site` (no `--preview`) after sign-off.

## Preview locally
```sh
python -m http.server 8000
```
Then open http://localhost:8000. Double-clicking index.html won't work, because the page loads its data with fetch.

## Publish with GitHub Pages (after DOH review)
Upload the contents of this folder to the repository root, then open Settings > Pages, choose
Deploy from a branch, main, /(root). Pages on a private repository needs a paid GitHub plan.

## Files
- `index.html`, `style.css`, `app.js`: the page.
- `data/`: written by the pipeline. Do not edit by hand; rebuild instead.
- `data/downloads/indicators.csv`: every value with its source report and page.
