import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { PrismaModule } from 'src/prisma/prisma.module';
import { SmsModule } from 'src/services/sms/sms.module';

import { AuthController, AdminAuthController } from './controller/auth.controller';
import { AuthService } from './service/auth.service';

import { RoleController } from './controller/role.controller';
import { RoleService } from './service/role.service';

import { PermissionController } from './controller/permission.controller';
import { PermissionService } from './service/permission.service';

@Module({
  imports: [
    PrismaModule,

    SmsModule,

    PassportModule,

    JwtModule.registerAsync({
      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),

        signOptions: {
          expiresIn: config.get('jwt.expiresIn', '1d'),
        },
      }),
    }),
  ],

  controllers: [AuthController, AdminAuthController, RoleController, PermissionController],

  providers: [AuthService, RoleService, PermissionService],

  exports: [AuthService, RoleService, PermissionService],
})
export class AuthModule {}