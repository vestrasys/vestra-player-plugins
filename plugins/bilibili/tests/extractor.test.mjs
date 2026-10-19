import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, matchesUrl, decodeMetadata, extractBilibili } from '../dist/extractor.js';
test('strict site URLs and no lookalike or credential bypass', () => {
  for (const url of ['https://www.bilibili.com/video/BV1xx411c7mD?p=2', 'https://b23.tv/Abc123']) assert.equal(matchesUrl(url), true);
  for (const url of ['file:///tmp/x', 'https://bilibili.com.evil/video/BV1', 'https://evil@www.bilibili.com/video/BV1', 'https://www.bilibili.com/live/1', 'https://www.bilibili.com/video/BV1:80']) assert.equal(matchesUrl(url), false);
  assert.equal(validateUrl('https://www.bilibili.com/video/BV1#part'), 'https://www.bilibili.com/video/BV1');
});
test('split audio and request headers survive decoding', () => {
  const result = decodeMetadata('https://b23.tv/x', { title:'test', http_headers:{Referer:'https://www.bilibili.com/'}, requested_formats:[{url:'https://cdn.example/video',vcodec:'avc1',acodec:'none'},{url:'https://cdn.example/audio',vcodec:'none',acodec:'mp4a',http_headers:{'User-Agent':'test'}}] });
  assert.equal(result.originalUrl,'https://b23.tv/x');
  assert.equal(result.audio.url,'https://cdn.example/audio');
  assert.equal(result.audio.headers.Referer,'https://www.bilibili.com/');
  assert.equal(result.audio.headers['User-Agent'],'test');
});
test('never accepts silent/incomplete extraction or header injection', () => {
  assert.throws(() => decodeMetadata('x',{requested_formats:[{url:'https://cdn.example/video',vcodec:'avc1',acodec:'none'}]}), /音轨/);
  assert.throws(() => decodeMetadata('x',{url:'https://cdn.example/a',vcodec:'avc1',acodec:'aac',http_headers:{Referer:'x\r\ny'}}), /请求头/);
});
test('pre-aborted resolution never starts process', async () => {
 const c = new AbortController(); c.abort(); await assert.rejects(extractBilibili('https://b23.tv/test',c.signal));
});
