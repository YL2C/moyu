from contextlib import closing
import gzip
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SOURCE = Path(__file__).resolve().parents[1] / 'server' / 'cloud-backup.py'
SPEC = importlib.util.spec_from_file_location('cloud_backup', SOURCE)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
TOKEN = 'test-token-that-is-definitely-long-enough'
ORIGIN = 'https://yl2c.github.io'


class BackupTest(unittest.TestCase):
    def test_http_replay_soft_delete_and_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / 'stories.sqlite3'
            with backup.init_server(db_path, '127.0.0.1', 0, TOKEN, {ORIGIN}) as server:
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                base = 'http://127.0.0.1:' + str(server.server_port) + backup.PREFIX

                def call(path, data=None, token=TOKEN, origin=ORIGIN):
                    headers = {'Origin': origin, 'Authorization': 'Bearer ' + token}
                    body = json.dumps(data).encode() if data is not None else None
                    with urlopen(Request(base + path, data=body, headers=headers), timeout=5) as response:
                        self.assertEqual(response.headers['Access-Control-Allow-Origin'], ORIGIN)
                        return json.load(response)

                def upload(records):
                    return call('records', {'device': 'phone', 'records': records})

                try:
                    with self.assertRaises(HTTPError) as denied:
                        call('stories', token='bad')
                    self.assertEqual(denied.exception.code, 401)
                    with self.assertRaises(HTTPError) as denied:
                        call('stories', origin='https://example.invalid')
                    self.assertEqual(denied.exception.code, 403)

                    story = {'store': 'stories', 'id': 's1', 'seq': 1, 'deleted': False,
                             'value': {'id': 's1', 'title': '原版', 'headId': 'n1'}}
                    node = {'store': 'nodes', 'id': 'n1', 'seq': 2, 'deleted': False,
                            'value': {'id': 'n1', 'storyId': 's1', 'text': 'before edit'}}
                    self.assertEqual(upload([story, node]), {'ack': [1, 2]})
                    self.assertEqual(upload([story, node]), {'ack': [1, 2]})
                    snapshot = backup.snapshot(db_path, root / 'snapshots', 2)
                    self.assertTrue(snapshot.is_file())

                    revised = dict(node, seq=3, value=dict(node['value'], text='after edit'))
                    tombstone = {'store': 'stories', 'id': 's1', 'seq': 4, 'deleted': True}
                    upload([revised, tombstone])
                    upload([node, story])
                    self.assertTrue(call('stories')['stories'][0]['deleted'])
                    recovered = call('story?device=phone&id=s1')
                    self.assertEqual(recovered['story']['title'], '原版')
                    self.assertEqual([node['text'] for node in recovered['nodes']], ['after edit'])

                    offline_delete = {'store': 'stories', 'id': 's2', 'seq': 5, 'deleted': True,
                                      'value': {'id': 's2', 'title': '从未联网上传过'}}
                    upload([offline_delete])
                    self.assertEqual(call('story?device=phone&id=s2')['story']['title'], '从未联网上传过')

                    copy = root / 'restored.sqlite3'
                    copy.write_bytes(gzip.decompress(snapshot.read_bytes()))
                    with closing(sqlite3.connect(copy)) as db:
                        archived = backup.read_story(db, 'phone', 's1')
                    self.assertEqual(archived['nodes'][0]['text'], 'before edit')
                    backup.snapshot(db_path, root / 'snapshots', 2)
                    backup.snapshot(db_path, root / 'snapshots', 2)
                    self.assertEqual(len(list((root / 'snapshots').glob('*.gz'))), 2)
                finally:
                    server.shutdown()
                    worker.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
