
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RolesSeeder } from './roles.seeder';
import { PermissionsSeeder } from './permissions.seeder';
import { AdminSeeder } from './admin.seeder';
import { UserSeeder } from './user.seeder';

@Injectable()
export class SeedOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedOrchestratorService.name);
  constructor(
    private readonly rolesSeeder: RolesSeeder,
    private readonly permissionsSeeder: PermissionsSeeder,
    private readonly adminSeeder: AdminSeeder,
    private readonly userSeeder: UserSeeder,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Starting seed sequence...');
    await this.rolesSeeder.run();
    await this.permissionsSeeder.run();
    await this.adminSeeder.run();
    await this.userSeeder.run();
    this.logger.log('Seed sequence complete.');
  }
}