import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FetchQuery } from '../fetch-query/crud.types';
import { FetchQueryPipe } from '../fetch-query/fetch-query.pipe';

export const FetchQueryParam = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): FetchQuery => {
    const request = ctx.switchToHttp().getRequest();
    const queryString = request.query.query || '';

    const pipe = new FetchQueryPipe();
    return pipe.transform(queryString);
  },
);
