"""Single-user Moyu backup service. Run behind the existing HTTPS reverse proxy."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import gzip
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
from time import time
from urllib.parse import parse_qs, urlsplit

PREFIX = '/cloud-backup/v1/'
STORES = ('stories', 'nodes', 'extras')
MAX_BODY = 64 * 1024 * 1024
ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS records (
  device TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  seq INTEGER NOT NULL, story_id TEXT, value TEXT, deleted INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (device, kind, id)
);
CREATE INDEX IF NOT EXISTS by_story ON records (device, story_id, kind, deleted);
'''
UPSERT = '''
INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(device, kind, id) DO UPDATE SET
  seq = excluded.seq, story_id = coalesce(excluded.story_id, records.story_id),
  value = coalesce(excluded.value, records.value), deleted = excluded.deleted,
  updated_at = excluded.updated_at
WHERE excluded.seq > records.seq
'''


def connect(path):
    return sqlite3.connect(str(path), timeout=15)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def valid_key(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and '\x00' not in value


def prepare_changes(data):
    if not isinstance(data, dict):
        raise ValueError('Invalid backup batch')
    device, records = data.get('device'), data.get('records')
    if not valid_id(device) or not isinstance(records, list) or not 1 <= len(records) <= 32:
        raise ValueError('Invalid backup batch')
    rows, ack = [], []
    updated = int(time() * 1000)
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Invalid record')
        kind, key, seq = (record.get(field) for field in ('store', 'id', 'seq'))
        value, deleted = record.get('value'), record.get('deleted')
        if kind not in STORES or not valid_key(key) or type(seq) is not int or not 0 < seq < 2**53 or type(deleted) is not bool:
            raise ValueError('Invalid record')
        story_id = key if kind == 'stories' else None
        if value is not None:
            if not isinstance(value, dict) or value.get('id') != key:
                raise ValueError('Invalid record data')
            if kind != 'stories':
                story_id = value.get('storyId')
                if not valid_key(story_id):
                    raise ValueError('Invalid parent story')
        elif not deleted:
            raise ValueError('Missing record data')
        rows.append((device, kind, key, seq, story_id, encode(value) if value is not None else None, deleted, updated))
        ack.append(seq)
    return rows, ack


def story_list(db):
    rows = db.execute("""SELECT device, id, value, deleted, updated_at FROM records
        WHERE kind = 'stories' AND value IS NOT NULL ORDER BY updated_at DESC""")
    return [dict(device=device, id=key, title=json.loads(value).get('title'),
                 deleted=bool(deleted), updatedAt=updated)
            for device, key, value, deleted, updated in rows]


def read_story(db, device, key):
    row = db.execute("""SELECT value FROM records WHERE device = ? AND kind = 'stories'
        AND id = ? AND value IS NOT NULL""", (device, key)).fetchone()
    if not row:
        return None
    story = json.loads(row[0])
    result = dict(story=story, nodes=[], extras=[])
    rows = db.execute("""SELECT kind, value FROM records WHERE device = ? AND story_id = ?
        AND kind IN ('nodes', 'extras') AND deleted = 0 AND value IS NOT NULL""", (device, key))
    for kind, value in rows:
        result[kind].append(json.loads(value))
    # A browser can close between the initial story-head save and the final reply.
    nodes = result['nodes']
    if story.get('headId') and not any(node['id'] == story['headId'] for node in nodes):
        newest = max(nodes, key=lambda node: node.get('updatedAt') or node.get('createdAt') or 0, default=None)
        story['headId'] = newest['id'] if newest else None
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, result=None):
        payload = encode(result).encode('utf-8') if result is not None else b''
        self.send_response(code)
        origin = self.headers.get('Origin')
        if origin in self.server.origins:
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_OPTIONS(self):
        self.reply(204 if self.headers.get('Origin') in self.server.origins else 403)

    def authenticated(self):
        origin = self.headers.get('Origin')
        if origin and origin not in self.server.origins:
            self.reply(403, {'error': 'Origin not allowed'})
            return False
        incoming = self.headers.get('Authorization', '').encode('utf-8')
        if not compare_digest(incoming, self.server.token):
            self.reply(401, {'error': 'Unauthorized'})
            return False
        return True

    def do_GET(self):
        if not self.authenticated():
            return
        url = urlsplit(self.path)
        result = None
        try:
            with closing(connect(self.server.db_path)) as db, db:
                db.execute('BEGIN')
                if url.path == PREFIX + 'stories':
                    result = {'stories': story_list(db)}
                elif url.path == PREFIX + 'story':
                    parts = parse_qs(url.query)
                    device = parts.get('device', [''])[0]
                    key = parts.get('id', [''])[0]
                    if valid_id(device) and valid_key(key):
                        result = read_story(db, device, key)
        except sqlite3.Error:
            self.reply(503, {'error': 'Database temporarily unavailable'})
            return
        if result is None:
            self.reply(404, {'error': 'Backup not found'})
        else:
            self.reply(200, result)

    def do_POST(self):
        if not self.authenticated():
            return
        if urlsplit(self.path).path != PREFIX + 'records':
            self.reply(404, {'error': 'Route not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > MAX_BODY:
                self.reply(413, {'error': 'Backup batch too large'})
                return
            if length <= 0:
                raise ValueError('Missing body')
            rows, ack = prepare_changes(json.loads(self.rfile.read(length)))
        except (ValueError, RecursionError, TimeoutError):
            self.reply(400, {'error': 'Invalid backup batch'})
            return
        try:
            with closing(connect(self.server.db_path)) as db, db:
                db.executemany(UPSERT, rows)
        except sqlite3.Error:
            self.reply(503, {'error': 'Database temporarily unavailable'})
            return
        self.reply(200, {'ack': ack})

    def setup(self):
        super().setup()
        self.connection.settimeout(35)

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass


def init_server(db_path, host, port, token, origins):
    if not re.fullmatch(r'[!-~]{32,256}', token):
        raise ValueError('MOYU_BACKUP_TOKEN must be a random token of at least 32 ASCII characters.')
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(db_path)) as db, db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript(SCHEMA)
    server = ThreadingHTTPServer((host, port), Handler)
    server.token = ('Bearer ' + token).encode('utf-8')
    server.origins = origins
    server.db_path = db_path
    return server


def snapshot(db_path, directory, keep):
    directory.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%S%fZ')
    filename = directory / ('moyu-' + now + '.sqlite3.gz')
    temp_db = filename.with_suffix('.tmp.sqlite3')
    temp_gz = filename.with_suffix('.tmp.gz')
    try:
        source = db_path.resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(source, uri=True, timeout=15)) as src, closing(connect(temp_db)) as dest:
            if not src.execute("SELECT 1 FROM sqlite_master WHERE name = 'records'").fetchone():
                raise ValueError('Missing Moyu backup schema')
            src.backup(dest)
            if dest.execute('PRAGMA quick_check').fetchone() != ('ok',):
                raise ValueError('Snapshot failed SQLite validation')
        with temp_db.open('rb') as raw, gzip.open(temp_gz, 'wb') as compressed:
            shutil.copyfileobj(raw, compressed)
        temp_gz.replace(filename)
        for old in sorted(directory.glob('moyu-*.sqlite3.gz'), reverse=True)[keep:]:
            old.unlink()
        return filename
    finally:
        for temporary in (temp_db, temp_gz):
            temporary.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path('/var/lib/moyu-backup/stories.sqlite3'))
    commands = parser.add_subparsers(dest='command', required=True)
    serve = commands.add_parser('serve')
    serve.add_argument('--host', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=8788)
    daily = commands.add_parser('snapshot')
    daily.add_argument('--directory', type=Path, default=Path('/var/lib/moyu-backup/snapshots'))
    daily.add_argument('--keep', type=int, default=30)
    export = commands.add_parser('export-story')
    export.add_argument('device')
    export.add_argument('story')
    args = parser.parse_args()
    if args.command == 'serve':
        origins = set(os.environ.get('MOYU_BACKUP_ORIGINS', 'https://yl2c.github.io').split())
        with init_server(args.db, args.host, args.port, os.environ.get('MOYU_BACKUP_TOKEN', ''), origins) as server:
            server.serve_forever()
    elif args.command == 'snapshot':
        if args.keep < 1:
            parser.error('--keep must be at least 1')
        print(snapshot(args.db, args.directory, args.keep))
    else:
        with closing(sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            data = read_story(db, args.device, args.story)
        if data is None:
            parser.error('story not found')
        print(encode(dict(app='moyu', schema=1, stories=[data['story']], nodes=data['nodes'], extras=data['extras'])))


if __name__ == '__main__':
    main()
