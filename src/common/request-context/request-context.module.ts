import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { GeoLookupService } from './geo-lookup.service';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

@Global()
@Module({
  providers: [RequestContextService, GeoLookupService],
  exports: [RequestContextService, GeoLookupService],
})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}