import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { FirebaseService } from './firebase.service';

// Needs FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY added to the Joi
// schema in env.validation.ts (all .optional()), read via configuration.ts.

@Module({
  imports: [ConfigModule],
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}