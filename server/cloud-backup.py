"""Single-user Moyu backup service. Run behind the existing HTTPS reverse proxy."""
import argparse
from base64 import b64decode, b64encode
from hashlib import sha256
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
from tempfile import TemporaryDirectory
from threading import Lock
from urllib.parse import parse_qs, urlsplit

PREFIX = '/cloud-backup/v1/'
STORES = ('stories', 'nodes', 'extras', 'chat')
CHAT_THREAD = 'deeptalk.v1.thread'
CHAT_TURN = 'deeptalk.v1.turn.'
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
    db = sqlite3.connect(str(path), timeout=15)
    db.execute("PRAGMA foreign_keys = ON")
    return db


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
        if kind == 'chat' and key != CHAT_THREAD and not (key.startswith(CHAT_TURN) and len(key) > len(CHAT_TURN)):
            raise ValueError('Invalid chat record key')
        story_id = key if kind == 'stories' else None
        if value is not None:
            if not isinstance(value, dict) or value.get('id') != key:
                raise ValueError('Invalid record data')
            if kind == 'chat' and 'data' not in value:
                raise ValueError('Missing chat record data')
            if kind in ('nodes', 'extras'):
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


def chat_list(db):
    rows = db.execute("""SELECT device, max(updated_at),
        sum(CASE WHEN id LIKE 'deeptalk.v1.turn.%' THEN 1 ELSE 0 END)
        FROM records WHERE kind = 'chat' AND deleted = 0
        GROUP BY device ORDER BY max(updated_at) DESC""")
    return [dict(device=device, updatedAt=updated, turns=turns) for device, updated, turns in rows]


def read_chat(db, device):
    rows = db.execute("""SELECT id, value FROM records WHERE device = ? AND kind = 'chat'
        AND deleted = 0 AND value IS NOT NULL ORDER BY id""", (device,))
    entries = [[key, json.loads(value)['data']] for key, value in rows]
    return dict(app='moyu-chat-backup', schema=1, entries=entries) if entries else None


VAULT_SCHEMA = '''
CREATE TABLE IF NOT EXISTS vault_key (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_object (
  id TEXT PRIMARY KEY, bytes BLOB NOT NULL, added INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_snapshot (
  id TEXT PRIMARY KEY, device TEXT NOT NULL, created INTEGER NOT NULL,
  manifest TEXT NOT NULL REFERENCES vault_object(id)
);
CREATE INDEX IF NOT EXISTS vault_device ON vault_snapshot(device, created DESC);
CREATE TABLE IF NOT EXISTS vault_ref (
  snapshot TEXT NOT NULL REFERENCES vault_snapshot(id) ON DELETE CASCADE,
  object TEXT NOT NULL REFERENCES vault_object(id), PRIMARY KEY(snapshot, object)
);
CREATE INDEX IF NOT EXISTS vault_object_ref ON vault_ref(object);
'''
HASH_ID = re.compile(r'[a-f0-9]{64}')
VAULT_BATCH_BYTES = 8 * 1024 * 1024
DAILY_SNAPSHOT = re.compile(r'moyu-[0-9]{8}T[0-9]{12}Z[.]sqlite3[.]gz|moyu-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{12}Z[.]sqlite3[.]gz')


class LegacySnapshots:
    def __init__(self, directory):
        self.directory = directory
        self.lock = Lock()
        self.cache = None
        self.source = None

    def list(self):
        return [path.name for path in sorted(self.directory.glob('moyu-*.sqlite3.gz'))
                if DAILY_SNAPSHOT.fullmatch(path.name) and path.is_file() and not path.is_symlink()]

    def open(self, name):
        if name not in self.list():
            raise ValueError('Unknown daily snapshot')
        with self.lock:
            if name != self.source:
                if self.cache:
                    self.cache.cleanup()
                self.cache = TemporaryDirectory(prefix='moyu-legacy-')
                self.source = None
                target = Path(self.cache.name) / 'legacy.sqlite3'
                with gzip.open(self.directory / name, 'rb') as original, target.open('wb') as output:
                    while block := original.read(1024 * 1024):
                        output.write(block)
                        if output.tell() > 1024 ** 3:
                            raise ValueError('Daily snapshot exceeds archive limit')
                self.source = name
            path = Path(self.cache.name) / 'legacy.sqlite3'
            return sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)

    def close(self):
        with self.lock:
            if self.cache:
                self.cache.cleanup()
                self.cache = None
                self.source = None


def object_id(value):
    return isinstance(value, str) and HASH_ID.fullmatch(value) is not None


def decode_binary(value, max_size):
    if not isinstance(value, str) or len(value) > ((max_size + 2) // 3) * 4:
        raise ValueError('Invalid ciphertext')
    data = b64decode(value, validate=True)
    if not 0 < len(data) <= max_size:
        raise ValueError('Invalid ciphertext length')
    return data


def current_envelope(db):
    row = db.execute('SELECT value FROM vault_key WHERE singleton = 1').fetchone()
    return json.loads(row[0]) if row else None


def vault_read(db, route, query):
    if route == 'vault':
        rows = db.execute(
            'SELECT id, device, created, manifest FROM vault_snapshot ORDER BY created DESC, rowid DESC'
        )
        return {'envelope': current_envelope(db), 'snapshots': [
            dict(id=key, device=device, createdAt=created, manifest=manifest)
            for key, device, created, manifest in rows
        ]}
    if route == 'vault/object':
        key = query.get('id', [''])[0]
        row = db.execute('SELECT bytes FROM vault_object WHERE id = ?', (key,)).fetchone() if object_id(key) else None
        return {'ciphertext': b64encode(row[0]).decode('ascii')} if row else None
    if route == 'vault/objects':
        ids = query.get('ids', [''])[0].split(',')
        if not 1 <= len(ids) <= 7 or not all(map(object_id, ids)):
            raise ValueError('Invalid chunk request')
        sql = 'SELECT id, bytes FROM vault_object WHERE id IN (' + ','.join('?' for _ in ids) + ')'
        rows = db.execute(sql, ids).fetchall()
        if len(rows) != len(ids):
            return None
        return {'objects': [[key, b64encode(block).decode('ascii')] for key, block in rows]}
    if route == 'vault/legacy':
        after = query.get('after', ['0'])[0]
        if not re.fullmatch(r'[0-9]{1,18}', after):
            raise ValueError('Invalid cursor')
        rows = db.execute('''SELECT rowid, device, kind, id, story_id, value, deleted
                             FROM records WHERE rowid > ? ORDER BY rowid LIMIT 16''', (int(after),))
        records = [dict(cursor=seq, device=device, kind=kind, id=key, storyId=story_id,
                        value=json.loads(value) if value is not None else None, deleted=bool(deleted))
                   for seq, device, kind, key, story_id, value, deleted in rows]
        return {'records': records, 'next': records[-1]['cursor'] if records else None}
    return None


def vault_write(db, route, data):
    if not isinstance(data, dict):
        raise ValueError('Invalid vault batch')
    db.execute('BEGIN IMMEDIATE')
    envelope = current_envelope(db)
    if route == 'vault/key':
        expected = data.get('expected')
        new = data.get('envelope')
        if (not isinstance(new, dict) or set(new) != {'version', 'rev', 'keyId', 'salt', 'wrapped'} or new['version'] != 1
                or not valid_id(new['rev']) or not valid_id(new['keyId']) or len(decode_binary(new['salt'], 16)) != 16
                or len(decode_binary(new['wrapped'], 60)) != 60):
            raise ValueError('Invalid key envelope')
        if envelope == new:
            return 200, {'envelope': envelope}
        if ((envelope['rev'] if envelope else None) != expected
                or envelope is not None and envelope['keyId'] != new['keyId']):
            return 409, {'error': 'Key envelope changed'}
        db.execute('INSERT OR REPLACE INTO vault_key VALUES (1, ?)', (encode(new),))
        return 200, {'envelope': new}
    if envelope is None:
        return 409, {'error': 'Initialize backup encryption first'}

    now = int(time() * 1000)
    if route == 'vault/objects':
        objects = data.get('objects')
        if not isinstance(objects, list) or not 1 <= len(objects) <= 32:
            raise ValueError('Invalid chunk batch')
        rows = []
        for item in objects:
            if not isinstance(item, list) or len(item) != 2 or not object_id(item[0]):
                raise ValueError('Invalid chunk')
            key, packed = item
            block = decode_binary(packed, VAULT_BATCH_BYTES)
            if len(block) < 28 or sha256(block).hexdigest() != key:
                raise ValueError('Invalid ciphertext digest')
            rows.append((key, block, now))
        db.executemany('''INSERT INTO vault_object VALUES (?, ?, ?)
                          ON CONFLICT(id) DO UPDATE SET added = excluded.added''', rows)
        return 200, {'ack': [row[0] for row in rows]}
    if route == 'vault/commit':
        key, device, manifest, parent, objects = (data.get(k) for k in ('id', 'device', 'manifest', 'parent', 'objects'))
        if (not valid_id(key) or not valid_id(device) or not object_id(manifest)
                or not (parent is None or valid_id(parent)) or not isinstance(objects, list)
                or len(objects) > 100_000 or not all(map(object_id, objects))):
            raise ValueError('Invalid encrypted snapshot')
        row = db.execute('SELECT device, created, manifest FROM vault_snapshot WHERE id = ?', (key,)).fetchone()
        if row:
            if row[0] != device or row[2] != manifest:
                return 409, {'error': 'Snapshot ID already used'}
            return 200, {'id': key, 'createdAt': row[1]}
        if data.get('keyRev') != envelope['rev']:
            return 409, {'error': 'Key envelope changed'}
        latest = db.execute(
            'SELECT id FROM vault_snapshot WHERE device = ? ORDER BY created DESC, rowid DESC LIMIT 1', (device,)
        ).fetchone()
        if (latest[0] if latest else None) != parent:
            return 409, {'error': 'Snapshot head changed'}

        refs = set(objects) | {manifest}
        sorted_refs = sorted(refs)
        for group in range(0, len(sorted_refs), 500):
            part = sorted_refs[group:group + 500]
            sql = 'SELECT count(*) FROM vault_object WHERE id IN (' + ','.join('?' for _ in part) + ')'
            if db.execute(sql, part).fetchone()[0] != len(part):
                return 422, {'error': 'Snapshot chunks missing'}
        db.execute('INSERT INTO vault_snapshot VALUES (?, ?, ?, ?)', (key, device, now, manifest))
        db.executemany('INSERT INTO vault_ref VALUES (?, ?)', ((key, ref) for ref in refs))
        # Keep recent revisions and one checkpoint per day for the previous 30 days.
        db.execute('''DELETE FROM vault_snapshot WHERE device = ? AND id NOT IN (
            SELECT id FROM (SELECT id FROM vault_snapshot WHERE device = ?
                            ORDER BY created DESC, rowid DESC LIMIT 30)
            UNION SELECT id FROM (
                SELECT id, row_number() OVER (
                    PARTITION BY created / 86400000 ORDER BY created DESC, rowid DESC
                ) AS day_rank FROM vault_snapshot WHERE device = ? AND created >= ?
            ) WHERE day_rank = 1
        )''', (device, device, device, now - 30 * 86400000))
        db.execute('''DELETE FROM vault_object WHERE added < ?
                      AND NOT EXISTS (SELECT 1 FROM vault_ref WHERE object = vault_object.id)''',
                   (now - 2 * 86400000,))
        return 200, {'id': key, 'createdAt': now}
    return 404, {'error': 'Route not found'}


class BackupServer(ThreadingHTTPServer):
    def server_close(self):
        super().server_close()
        self.legacy_snapshots.close()


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
        query = parse_qs(url.query)
        try:
            history = query.get('history', [''])[0] if url.path == PREFIX + 'vault/legacy' else ''
            database = self.server.legacy_snapshots.open(history) if history else connect(self.server.db_path)
            with closing(database) as db, db:
                db.execute('BEGIN')
                if url.path == PREFIX + 'vault/legacy-history':
                    result = {'snapshots': self.server.legacy_snapshots.list()}
                elif url.path == PREFIX + 'vault' or url.path.startswith(PREFIX + 'vault/'):
                    result = vault_read(db, url.path[len(PREFIX):], query)
                elif url.path == PREFIX + 'stories':
                    result = {'stories': story_list(db)}
                elif url.path == PREFIX + 'chat/backups':
                    result = {'backups': chat_list(db)}
                elif url.path == PREFIX + 'chat/archive':
                    device = parse_qs(url.query).get('device', [''])[0]
                    if valid_id(device):
                        result = read_chat(db, device)
                elif url.path == PREFIX + 'story':
                    parts = parse_qs(url.query)
                    device = parts.get('device', [''])[0]
                    key = parts.get('id', [''])[0]
                    if valid_id(device) and valid_key(key):
                        result = read_story(db, device, key)
        except (ValueError, OSError, EOFError):
            self.reply(400, {'error': 'Invalid vault request'})
            return
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
        path = urlsplit(self.path).path
        if path.startswith(PREFIX + 'vault/'):
            self.post_vault(path[len(PREFIX):])
            return
        if path != PREFIX + 'records':
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
                db.execute('BEGIN IMMEDIATE')
                if current_envelope(db):
                    self.reply(409, {'error': 'Encrypted backup enabled'})
                    return
                db.executemany(UPSERT, rows)
        except sqlite3.Error:
            self.reply(503, {'error': 'Database temporarily unavailable'})
            return
        self.reply(200, {'ack': ack})

    def post_vault(self, route):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= VAULT_BATCH_BYTES:
                self.reply(413, {'error': 'Encrypted batch too large'})
                return
            data = json.loads(self.rfile.read(length))
            with closing(connect(self.server.db_path)) as db, db:
                code, result = vault_write(db, route, data)
        except (ValueError, RecursionError, TimeoutError):
            self.reply(400, {'error': 'Invalid encrypted backup request'})
            return
        except sqlite3.Error:
            self.reply(503, {'error': 'Database temporarily unavailable'})
            return
        self.reply(code, result)

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
        db.executescript(SCHEMA + VAULT_SCHEMA)
    server = BackupServer((host, port), Handler)
    server.legacy_snapshots = LegacySnapshots(db_path.parent / 'snapshots')
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
    chat_export = commands.add_parser('export-chat')
    chat_export.add_argument('device')
    args = parser.parse_args()
    if args.command == 'serve':
        origins = set(os.environ.get('MOYU_BACKUP_ORIGINS', 'https://yl2c.github.io').split())
        with init_server(args.db, args.host, args.port, os.environ.get('MOYU_BACKUP_TOKEN', ''), origins) as server:
            server.serve_forever()
    elif args.command == 'snapshot':
        if args.keep < 1:
            parser.error('--keep must be at least 1')
        print(snapshot(args.db, args.directory, args.keep))
    elif args.command == 'export-chat':
        with closing(sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            data = read_chat(db, args.device)
        if data is None:
            parser.error('chat backup not found')
        print(encode(data))
    else:
        with closing(sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            data = read_story(db, args.device, args.story)
        if data is None:
            parser.error('story not found')
        print(encode(dict(app='moyu', schema=1, stories=[data['story']], nodes=data['nodes'], extras=data['extras'])))


if __name__ == '__main__':
    main()
