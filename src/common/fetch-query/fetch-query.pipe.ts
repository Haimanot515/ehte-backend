import {
  PipeTransform,
  Injectable,
  BadRequestException,
} from '@nestjs/common';

import { FetchQuery } from './crud.types';
import {
  parseFields,
  parseSort,
  parseFilter,
} from './fetch-query.parser';

@Injectable()
export class FetchQueryPipe implements PipeTransform<string, FetchQuery> {
  transform(value: string): FetchQuery {
    try {
      const params = new URLSearchParams(value || '');
      const query = new FetchQuery();

      // Pagination
      const page = params.get('page');

      if (page) {
        const p = parseInt(page, 10);

        if (isNaN(p) || p < 1) {
          throw new Error('Invalid page');
        }

        query.page = p;
      }

      const limit = params.get('limit');

      if (limit) {
        const l = parseInt(limit, 10);

        if (isNaN(l) || l < 1 || l > 100) {
          throw new Error('Invalid limit');
        }

        query.limit = l;
      }

      // Fields
      const fields = params.get('fields');

      if (fields) {
        query.select = parseFields(fields);
      }

      // Sorting
      const sort = params.get('sort');

      if (sort) {
        query.orderBy = parseSort(sort);
      }

      // Filtering
      query.where = [];

      const filter = params.get('filter');

      if (filter) {
        query.where = parseFilter(filter);
      }

      return query;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Invalid query';

      throw new BadRequestException(
        `Invalid query string: ${message}`,
      );
    }
  }
}