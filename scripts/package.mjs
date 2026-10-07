// Packages the built game (dist/) as a drop-in Flask blueprint: release/pressure_lab/ and release/pressure-lab.zip.
// Run with `npm run package` (it builds first).
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const release = join(root, 'release');
const pkg = join(release, 'pressure_lab');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first');

rmSync(release, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
cpSync(dist, join(pkg, 'game'), { recursive: true });

writeFileSync(join(pkg, '__init__.py'), `"""Pressure Lab, packaged as a Flask blueprint.

Usage in your Flask app:

    from pressure_lab import bp as pressure_lab
    app.register_blueprint(pressure_lab, url_prefix="/pressure-lab")

The game is a static site in ./game; this blueprint just serves it.
"""
from pathlib import Path

from flask import Blueprint, redirect, request, send_from_directory

# Python 3.6+. Passed to Flask as a plain string, which older Flask versions expect.
GAME_DIR = str(Path(__file__).resolve().parent / "game")

bp = Blueprint("pressure_lab", __name__)


@bp.route("")
def no_slash():
    # The game loads its assets by relative path, so its page must be served with a trailing slash.
    return redirect(request.path + "/", code=301)


@bp.route("/")
def index():
    return send_from_directory(GAME_DIR, "index.html")


@bp.route("/<path:path>")
def asset(path):
    return send_from_directory(GAME_DIR, path)
`);

execFileSync('zip', ['-qr', 'pressure-lab.zip', 'pressure_lab'], { cwd: release });
console.log('Packaged: release/pressure_lab/ (Flask blueprint) and release/pressure-lab.zip');
