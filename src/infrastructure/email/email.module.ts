import { Global, Module } from '@nestjs/common';

import { EmailService } from './email.service';
import { EmailTemplateService } from './email-template.service';

@Global()
@Module({
  providers: [EmailService, EmailTemplateService],
  exports: [EmailService, EmailTemplateService],
})
export class EmailModule {}