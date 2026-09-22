import { Injectable } from '@nestjs/common';
import { UssdSessionState, UssdStep } from '../dto/ussd-session.dto';
import { RedisService } from '../../../services/redis/redis.service';

// Must be >= the USSD gateway's own per-request session timeout.
const SESSION_TTL_SECONDS = 180;
const KEY_PREFIX = 'ussd:session:';

@Injectable()
export class UssdSessionService {
  constructor(private readonly redis: RedisService) {}

  async get(sessionId: string): Promise<UssdSessionState | null> {
    return this.redis.get<UssdSessionState>(KEY_PREFIX + sessionId);
  }

  async start(sessionId: string, phoneNumber: string): Promise<UssdSessionState> {
    const state: UssdSessionState = {
      sessionId,
      phoneNumber,
      step: 'ROOT',
      data: {},
      createdAt: Date.now(),
    };
    await this.save(state);
    return state;
  }

  async save(state: UssdSessionState): Promise<void> {
    await this.redis.set(KEY_PREFIX + state.sessionId, state, SESSION_TTL_SECONDS);
  }

  async setStep(
    state: UssdSessionState,
    step: UssdStep,
    patch: Record<string, string> = {},
  ): Promise<UssdSessionState> {
    const next: UssdSessionState = { ...state, step, data: { ...state.data, ...patch } };
    await this.save(next);
    return next;
  }

  async end(sessionId: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + sessionId);
  }
}