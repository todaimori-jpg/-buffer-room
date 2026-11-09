import os
from pathlib import Path
import tempfile
import hashlib
import shutil
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from server import app as service


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.data_patch=patch.object(service,'DATA',Path(self.directory.name)); self.data_patch.start()
        self.key_patch=patch.object(service,'API_KEY','test-only-connection-key'); self.key_patch.start()
        service.initialize()
        self.client=TestClient(service.app)
        self.auth={'Authorization':'Bearer test-only-connection-key'}

    def tearDown(self):
        self.client.close(); self.key_patch.stop(); self.data_patch.stop(); self.directory.cleanup()

    def test_auth_and_public_health(self):
        self.assertEqual(self.client.get('/api/health').status_code,200)
        self.assertEqual(self.client.get('/api/connection').status_code,401)
        self.assertEqual(self.client.get('/api/connection',headers={'Authorization':'Bearer wrong'}).status_code,401)
        self.assertEqual(self.client.get('/api/connection',headers=self.auth).status_code,200)
        with patch.object(service,'API_KEY',''):
            self.assertEqual(self.client.get('/api/connection',headers=self.auth).status_code,503)

    def test_url_and_quality_validation_before_any_extraction(self):
        with patch.object(service,'tools_ready',return_value=True), patch.object(service.executor,'submit') as submit:
            for url in ('https://127.0.0.1/secret','https://youtube.com.evil.test/watch?v=jNQXAC9IVRw','file:///etc/passwd','https://www.youtube.com/playlist?list=x'):
                self.assertEqual(self.client.post('/api/jobs',json={'url':url},headers=self.auth).status_code,422)
            self.assertEqual(self.client.post('/api/jobs',json={'url':'https://youtu.be/jNQXAC9IVRw','quality':1080},headers=self.auth).status_code,422)
            submit.assert_not_called()

    def test_duplicate_jobs_share_one_preparation(self):
        with patch.object(service,'tools_ready',return_value=True), patch.object(service.executor,'submit') as submit:
            first=self.client.post('/api/jobs',json={'url':'https://youtu.be/jNQXAC9IVRw?si=ignored','quality':360},headers=self.auth).json()
            second=self.client.post('/api/jobs',json={'url':'https://youtube.com/watch?v=jNQXAC9IVRw&list=ignored','quality':360},headers=self.auth).json()
            self.assertEqual(first['id'],second['id']); self.assertEqual(submit.call_count,1)
            self.assertEqual(first['url'],'https://www.youtube.com/watch?v=jNQXAC9IVRw')

    def test_media_ranges_return_exact_bytes_and_require_auth(self):
        id=uuid4().hex; now=time.time(); directory=service.DATA/id; directory.mkdir()
        content=bytes(range(256))*21000
        (directory/'video.mp4').write_bytes(content)
        service.write_job({'id':id,'status':'ready','created':now,'updated':now,'size':len(content)})
        url=f'/api/jobs/{id}/media'
        self.assertEqual(self.client.get(url).status_code,401)
        for start,end in ((0,1),(2097149,2097161),(len(content)-21,len(content)-1)):
            response=self.client.get(url,headers={**self.auth,'Range':f'bytes={start}-{end}'})
            self.assertEqual(response.status_code,206)
            self.assertEqual(response.content,content[start:end+1])
            self.assertEqual(response.headers['content-range'],f'bytes {start}-{end}/{len(content)}')
        tail=self.client.get(url,headers={**self.auth,'Range':'bytes=-9'})
        self.assertEqual(tail.content,content[-9:])
        head=self.client.head(url,headers={**self.auth,'Range':'bytes=0-1'})
        self.assertEqual(head.status_code,206); self.assertEqual(head.content,b''); self.assertEqual(head.headers['content-length'],'2')
        invalid=self.client.get(url,headers={**self.auth,'Range':f'bytes={len(content)}-'})
        self.assertEqual(invalid.status_code,416)
        self.assertEqual(self.client.get('/api/jobs/../../etc/passwd',headers=self.auth).status_code,404)

    def test_unfinished_video_cannot_be_served(self):
        id=uuid4().hex; now=time.time()
        service.write_job({'id':id,'status':'preparing','created':now,'updated':now})
        self.assertEqual(self.client.get(f'/api/jobs/{id}/media',headers=self.auth).status_code,409)

    def test_completed_server_copy_expires_but_active_work_does_not(self):
        old=time.time()-service.TTL-60
        completed=uuid4().hex; active=uuid4().hex
        for id,status in ((completed,'ready'),(active,'preparing')):
            (service.DATA/id).mkdir()
            service.write_job({'id':id,'status':status,'created':old,'updated':old})
        service.cleanup(force=True)
        self.assertFalse((service.DATA/completed).exists())
        self.assertTrue((service.DATA/active).exists())

    def test_real_mp4_preparation_and_fingerprint_with_local_fixture(self):
        id=uuid4().hex; now=time.time()
        service.write_job({'id':id,'status':'queued','url':'https://www.youtube.com/watch?v=jNQXAC9IVRw','quality':360,'created':now,'updated':now})
        original=service.run_process
        def fixture_extractor(job_id,command,timeout,progress=False):
            if progress: shutil.copyfile(service.ROOT/'dist/demo.mp4',service.DATA/id/'source.mp4')
            else: original(job_id,command,timeout,progress)
        with patch.object(service,'run_process',side_effect=fixture_extractor): service.prepare(id)
        job=service.load_job(id)
        self.assertEqual(job['status'],'ready',job.get('error'))
        media=(service.DATA/id/'video.mp4').read_bytes()
        self.assertEqual(job['sha256'],hashlib.sha256(media).hexdigest())
        self.assertEqual(job['size'],len(media)); self.assertEqual(job['height'],360)
        self.assertAlmostEqual(job['duration'],12,places=0)

    def test_html_masquerading_as_video_is_never_ready(self):
        id=uuid4().hex; now=time.time()
        service.write_job({'id':id,'status':'queued','url':'https://www.youtube.com/watch?v=jNQXAC9IVRw','quality':360,'created':now,'updated':now})
        def unavailable(job_id,command,timeout,progress=False):
            (service.DATA/id/'source.mp4').write_bytes(b'<html><title>Site Unavailable</title></html>')
        with patch.object(service,'run_process',side_effect=unavailable): service.prepare(id)
        job=service.load_job(id)
        self.assertEqual(job['status'],'error')
        self.assertIn('instead of video data',job['error'])


if __name__=='__main__': unittest.main()
