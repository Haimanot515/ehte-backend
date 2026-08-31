
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { PrismaModule } from 'src/prisma/prisma.module';

import { AuthController } from './controller/auth.controller';
import { AuthService } from './service/auth.service';

import { RoleController } from './controller/role.controller';
import { RoleService } from './service/role.service';

@Module({
  imports: [
    PrismaModule,

    PassportModule,

    JwtModule.registerAsync({
      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),

        signOptions: {
          expiresIn: config.get('jwt.expiresIn', '1d') as any,
        },
      }),
    }),
  ],

  controllers: [
    AuthController,
    RoleController,
  ],

  providers: [
    AuthService,
    RoleService,
  ],

  exports: [
    AuthService,
    RoleService,
  ],
})
export class AuthModule {}
