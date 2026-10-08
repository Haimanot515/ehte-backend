import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { once } from 'events';
import * as net from 'net';

const CHUNK_SIZE = 64 * 1024;

export interface ClamavScanResult {
  clean: boolean;
  signature?: string;
}

@Injectable()
export class ClamavService {
  private readonly logger = new Logger(ClamavService.name);

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<string>('CLAMAV_ENABLED') === 'true';
  }

  async scanBuffer(buffer: Buffer): Promise<ClamavScanResult> {
    const reply = await this.stream(buffer);
    const found = /^stream:\s*(.+?)\s+FOUND$/.exec(reply);
    if (found) return { clean: false, signature: found[1] };
    if (reply.endsWith('OK')) return { clean: true };
    throw new Error(`clamav_unexpected_reply:${reply}`);
  }

  async assertClean(buffer: Buffer): Promise<void> {
    let result: ClamavScanResult;
    try {
      result = await this.scanBuffer(buffer);
    } catch (err) {
      this.logger.error(`Scanner unavailable: ${(err as Error).message}`);
      throw new ServiceUnavailableException('file_scan_unavailable');
    }
    if (!result.clean) {
      this.logger.warn(`Upload blocked, signature=${result.signature}`);
      throw new BadRequestException('file_infected');
    }
  }

  private stream(buffer: Buffer): Promise<string> {
    const host = this.config.get<string>('CLAMAV_HOST') ?? '127.0.0.1';
    const port = Number(this.config.get<string>('CLAMAV_PORT') ?? 3310);
    const timeoutMs = Number(this.config.get<string>('CLAMAV_TIMEOUT_MS') ?? 120000);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const parts: Buffer[] = [];

      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => socket.destroy(new Error('clamav_timeout')));
      socket.on('error', reject);
      socket.on('data', (data) => parts.push(data));
      socket.on('close', () =>
        resolve(Buffer.concat(parts).toString('utf8').replace(/\0/g, '').trim()),
      );
      socket.on('connect', () => {
        this.send(socket, buffer).catch((err) => socket.destroy(err));
      });
    });
  }

  private async send(socket: net.Socket, buffer: Buffer): Promise<void> {
    socket.write('zINSTREAM\0');

    for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
      if (socket.destroyed) return;
      const part = buffer.subarray(offset, offset + CHUNK_SIZE);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(part.length, 0);

      if (!socket.write(Buffer.concat([header, part]))) {
        const stop = new AbortController();
        await Promise.race([
          once(socket, 'drain', { signal: stop.signal }),
          once(socket, 'close', { signal: stop.signal }),
        ]).finally(() => stop.abort());
      }
    }

    socket.write(Buffer.alloc(4));
  }
}
