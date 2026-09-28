import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';
import { BillingModule } from 'src/modules/billing/billing.module';

import { UserController } from './controller/user.controller';
import { ReportController } from './controller/report.controller';
import { PostController } from './controller/post.controller';
import { MissingPersonController } from './controller/missing-person.controller';
import { InformationSubmissionController } from './controller/information-submission.controller';
import { VictimProfileController } from './controller/victim-profile.controller';
// import { SupportController } from './controller/support.controller';

import { UserService } from './service/user.service';
import { ReportService } from './service/report.service';
import { PostService } from './service/post.service';
import { MissingPersonService } from './service/missing-person.service';
import { InformationSubmissionService } from './service/information-submission.service';
import { VictimProfileService } from './service/victim-profile.service';
// import { SupportService } from './service/support.service';

// G33 (billing review, section 9): the TODO that used to live here was
// stale. Support.amount, Support.recipientAmount, Support.organizationAmount
// and Support.platformAmount all exist on the Support model
// (prisma/schema/support.prisma) — the "fields don't exist yet" premise for
// disabling this module was wrong by the time of this review.
//
// SupportController/SupportService are still commented out above only
// because neither file was included in this upload, so their current
// constructor signature can't be verified from here. BillingModule is
// wired into `imports` below so that whichever AllocationService/
// PaymentService dependency SupportService turns out to need is already
// available — re-enabling should be a matter of:
//   1. uncommenting the two imports above,
//   2. adding SupportController to `controllers` and SupportService to
//      `providers`/`exports`,
//   3. confirming SupportService listens for BILLING_PAYMENT_PAID and
//      confirms the Support row once PaymentService.reconcile() marks the
//      payment PAID (see G22/G33 in the billing review — this is the
//      "Support confirmation" half nothing currently exercises).
@Module({
  // AuthModule imported so UserService can inject OtpUtil and LockoutUtil,
  // both exported from AuthModule (see auth.module.ts). No circular
  // dependency — AuthModule does not import CoreModule.
  //
  // BillingModule imported (forwardRef, since BillingModule's
  // FundingQueryService reads Core's Prisma-backed tables and a future
  // SupportService here will depend on BillingModule's AllocationService/
  // PaymentService/BillingEventsService) so re-enabling Support only needs
  // the three steps in the comment above, not another DI change here.
  imports: [AuthModule, forwardRef(() => BillingModule)],

  controllers: [
    UserController,
    ReportController,
    PostController,
    MissingPersonController,
    InformationSubmissionController,
    VictimProfileController,
    // SupportController,
  ],

  providers: [
    UserService,
    ReportService,
    PostService,
    MissingPersonService,
    InformationSubmissionService,
    VictimProfileService,
    // SupportService,
  ],

  exports: [
    UserService,
    ReportService,
    PostService,
    MissingPersonService,
    InformationSubmissionService,
    VictimProfileService,
    // SupportService,
  ],
})
export class CoreModule {}