import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCurlCommand } from '../curl-import'

test('parses a simple GET curl', () => {
  const data = parseCurlCommand("curl 'https://api.example.com/users?page=2'")
  assert.deepEqual(data, { method: 'GET', url: 'https://api.example.com/users?page=2' })
})

test('parses method, headers, and a JSON body', () => {
  const data = parseCurlCommand(
    `curl -X POST 'https://api.example.com/users' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Trace: abc" \\\n  --data '{"name":"Acme"}'`,
  )
  assert.equal(data.method, 'POST')
  assert.equal(data.url, 'https://api.example.com/users')
  assert.deepEqual(JSON.parse(data.headers ?? '{}'), { 'Content-Type': 'application/json', 'X-Trace': 'abc' })
  assert.equal(data.body, '{"name":"Acme"}')
  assert.equal(data.bodyMode, 'json')
})

test('a data flag without -X implies POST and non-JSON bodies become form-urlencoded', () => {
  const data = parseCurlCommand("curl https://api.example.com/token -d 'grant_type=client_credentials' -d 'scope=read'")
  assert.equal(data.method, 'POST')
  assert.equal(data.body, 'grant_type=client_credentials&scope=read')
  assert.equal(data.bodyMode, 'text')
  // curl -d defaults to form encoding — keep that contract on import
  assert.deepEqual(JSON.parse(data.headers ?? '{}'), { 'Content-Type': 'application/x-www-form-urlencoded' })
})

test('maps -u to basic auth and -b to the cookie field', () => {
  const data = parseCurlCommand("curl -u 'user:pa:ss' -b 'session=abc' https://api.example.com/me")
  assert.deepEqual(data.auth, { type: 'basic', username: 'user', password: 'pa:ss' })
  assert.equal(data.cookie, 'session=abc')
})

test('maps -F to a multipart body and -L to followRedirects', () => {
  const data = parseCurlCommand("curl -L -F 'field1=value1' -F 'field2=value2' https://api.example.com/upload")
  assert.equal(data.bodyMode, 'multipart')
  assert.deepEqual(JSON.parse(data.body ?? '{}'), { field1: 'value1', field2: 'value2' })
  assert.equal(data.followRedirects, true)
})

test('handles --url, long flags, and ignored flags', () => {
  const data = parseCurlCommand(
    "curl --request PUT --url https://api.example.com/item/1 --header 'Accept: application/json' --compressed -s -k -o out.json",
  )
  assert.equal(data.method, 'PUT')
  assert.equal(data.url, 'https://api.example.com/item/1')
  assert.deepEqual(JSON.parse(data.headers ?? '{}'), { Accept: 'application/json' })
})

test('rejects text that is not a curl command or has no URL', () => {
  assert.throws(() => parseCurlCommand('wget https://example.com'), /curl/i)
  assert.throws(() => parseCurlCommand('curl -X GET'), /URL/i)
})
