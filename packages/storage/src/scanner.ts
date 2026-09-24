import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { MalwareScanner, ScanResult } from './types';

/** ClamAV clamd INSTREAM protocol client. */
export class ClamdScanner implements MalwareScanner {
  readonly mode = 'clamd' as const;
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 120_000,
  ) {}

  scan(stream: Readable): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let response = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('clamd scan timed out'));
      }, this.timeoutMs);
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        stream.on('data', (chunk: Buffer) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        });
        stream.on('end', () => socket.write(Buffer.from([0, 0, 0, 0])));
        stream.on('error', (e) => {
          clearTimeout(timer);
          socket.destroy();
          reject(e);
        });
      });
      socket.on('data', (d) => (response += d.toString('utf8')));
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        const text = response.replace(/\0/g, '').trim();
        if (text.endsWith('OK')) resolve({ clean: true, engine: 'clamd' });
        else if (text.includes('FOUND')) resolve({ clean: false, engine: 'clamd', signature: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
        else reject(new Error(`Unexpected clamd response: ${text.slice(0, 120)}`));
      });
    });
  }

  healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, detail: 'timeout' });
      }, 5000);
      socket.connect(this.port, this.host, () => socket.write('zPING\0'));
      socket.on('data', (d) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: d.toString().includes('PONG') });
      });
      socket.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: e.message });
      });
    });
  }
}

/**
 * Development-only scanner: marks files as not scanned (`devBypass`). Configuration refuses this
 * mode in production, and the UI labels such files "Not scanned (development)".
 */
export class DevBypassScanner implements MalwareScanner {
  readonly mode = 'disabled-dev-only' as const;
  async scan(stream: Readable): Promise<ScanResult> {
    for await (const _ of stream) {
      // drain
    }
    return { clean: true, engine: 'none', devBypass: true };
  }
  async healthCheck() {
    return { ok: true, detail: 'development bypass — no malware scanning' };
  }
}
