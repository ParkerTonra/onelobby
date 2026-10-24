// In-process adapter around MockNode. This is the reference for the adapter contract (see ../README.md).
import { MockNode } from './node.mjs';
import { hex, unhex } from '../../../spec/reference/codec.mjs';

export default function createAdapter() {
  let handler = () => {};
  let node = null;
  const io = {
    send: (to, channel, bytes) => handler({ ev: 'send', to, channel, hex: hex(bytes) }),
    emit: (e) => handler(e),
  };
  return {
    set onevent(h) { handler = h; },
    async call(op, a = {}) {
      switch (op) {
        case 'init': return { name: 'mock', capabilities: ['host', 'joiner', 'lockstep', 'raw', 'chat', 'voice', 'migration', 'deflate'] };
        case 'start': node?.stop(); node = new MockNode(io); node.start(a); return {};
        case 'begin': node.begin(); return {};
        case 'link_open': node.linkOpen(a.peerId); return {};
        case 'link_close': node.linkClose(a.peerId); return {};
        case 'recv': node.recv(a.from, a.channel, unhex(a.hex)); return {};
        case 'command': node.command(a.x, a.y); return {};
        case 'chat_send': node.chatSend(a.text); return {};
        case 'chat_host_mute': node.hostMute(a.peerId, a.muted); return {};
        case 'voice_send': node.voiceSend(a.frames, !!a.endOfBurst); return {};
        case 'raw_send': node.rawSend(a.to, unhex(a.hex), a.channel ?? 'reliable'); return {};
        case 'hash_at': return { hash: node.hashAt(a.tick) };
        case 'state': return node.state();
        case 'stop': node?.stop(); node = null; return {};
        default: throw new Error(`unknown op ${op}`);
      }
    },
    async dispose() { node?.stop(); },
  };
}
