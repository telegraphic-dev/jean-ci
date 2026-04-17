import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayChatSessionUrl } from '../lib/openclaw-chat-links.ts';

test('buildGatewayChatSessionUrl appends /chat and url-encodes session keys', () => {
  const original = process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
  process.env.OPENCLAW_GATEWAY_PUBLIC_URL = 'https://carita.tailf99986.ts.net';

  try {
    assert.equal(
      buildGatewayChatSessionUrl('agent:main:discord:channel:1490241981685698620'),
      'https://carita.tailf99986.ts.net/chat?session=agent%3Amain%3Adiscord%3Achannel%3A1490241981685698620'
    );
  } finally {
    if (original == null) delete process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
    else process.env.OPENCLAW_GATEWAY_PUBLIC_URL = original;
  }
});

test('buildGatewayChatSessionUrl preserves configured path prefixes', () => {
  const original = process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
  process.env.OPENCLAW_GATEWAY_PUBLIC_URL = 'https://gateway.example.com/openclaw';

  try {
    assert.equal(
      buildGatewayChatSessionUrl('agent:main:test'),
      'https://gateway.example.com/openclaw/chat?session=agent%3Amain%3Atest'
    );
  } finally {
    if (original == null) delete process.env.OPENCLAW_GATEWAY_PUBLIC_URL;
    else process.env.OPENCLAW_GATEWAY_PUBLIC_URL = original;
  }
});
