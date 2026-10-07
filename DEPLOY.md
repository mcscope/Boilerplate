# Deploying Pressure Lab

The game is a static site with no server-side code. `npm run package` builds it and wraps it as a drop-in
**Flask blueprint**.

## Build the package

```sh
npm install        # first time only
npm run package
```

This produces:

- `release/pressure_lab/`: a Python package (`__init__.py` + the built game in `game/`)
- `release/pressure-lab.zip`: the same folder, zipped

## Add it to a Flask app (mcscope.com)

1. Copy `release/pressure_lab/` into your Flask project, next to your app module (or unzip
   `pressure-lab.zip` there).
2. Register the blueprint at whatever path you like:

   ```python
   from pressure_lab import bp as pressure_lab
   app.register_blueprint(pressure_lab, url_prefix="/pressure-lab")
   ```

3. Deploy as usual. The game is at `https://mcscope.com/pressure-lab/`. A request for `/pressure-lab` without the
   trailing slash redirects to it, because the game loads its assets by relative path.

Any `url_prefix` works, including `/` if the game should be the whole site.

## Notes

- **No build step on the server.** The package contains only static files plus a few lines of Flask.
- **Fonts** load from Google Fonts. Everything else is self-contained.
- **Saved data** (solved puzzles, personal bests, engine and mode choices) lives in each player's browser
  `localStorage`, per domain. Moving domains starts players fresh.
- **Updating:** rerun `npm run package` and replace the `pressure_lab/` folder. Asset filenames are
  content-hashed, so browsers won't keep stale copies.
- **Other hosts:** `dist/` (after `npm run build`) is a plain static site that works from any URL path on any
  static host.
