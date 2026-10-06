import { Module } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';

import { ReportController } from './controller/report.controller';

import { ReportCommonService } from './service/report-common.service';
import { ReportSubmissionService } from './service/report-submission.service';
import { ReportReporterService } from './service/report-reporter.service';
import { ReportCommunicationService } from './service/report-communication.service';
import { ReportInboxService } from './service/report-inbox.service';
import { ReportWorkflowService } from './service/report-workflow.service';
import { ReportLifecycleService } from './service/report-lifecycle.service';
import { ReportCaseManagementService } from './service/report-case-management.service';
import { ReportAccessService } from './service/report-access.service';
import { ReportLocationService } from './service/report-location.service';
import { ReportSearchService } from './service/report-search.service';
import { ReportExportService } from './service/report-export.service';
import { ReportStatsService } from './service/report-stats.service';

@Module({
  imports: [AuthModule],

  controllers: [ReportController],

  providers: [
    ReportCommonService,
    ReportSubmissionService,
    ReportReporterService,
    ReportCommunicationService,
    ReportInboxService,
    ReportWorkflowService,
    ReportLifecycleService,
    ReportCaseManagementService,
    ReportAccessService,
    ReportLocationService,
    ReportSearchService,
    ReportExportService,
    ReportStatsService,
  ],
})
export class ReportModule {}
