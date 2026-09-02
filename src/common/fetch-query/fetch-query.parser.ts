import { BadRequestException } from '@nestjs/common';
import { Where, Order } from './crud.types';
import { operatorMap } from './filter-operator-map';

export function parseFilter(filterStr?: string): Where[][] {
  if (!filterStr) return [];

  const andGroups = filterStr.split(';').map((group) => group.trim());

  return andGroups.map((group) => {
    if (!group) return [];

    const orConditions = group.split('|').map((cond) => cond.trim());

    return orConditions.map((cond) => {
      const parts = cond.split(':');

      if (parts.length < 2) {
        throw new BadRequestException(`Invalid filter condition: ${cond}`);
      }

      const column = decodeURIComponent(parts[0]);
      const operatorShort = parts[1].toLowerCase();

      const operator = operatorMap[operatorShort];

      if (!operator) {
        throw new BadRequestException(`Unknown operator: ${operatorShort}`);
      }

      let value: any = parts.length > 2 ? decodeURIComponent(parts.slice(2).join(':')) : undefined;

      // Array operators
      if (['in', 'nin', 'between', 'all'].includes(operatorShort)) {
        if (value === undefined) {
          throw new BadRequestException(`Operator ${operatorShort} requires a value`);
        }

        value = value.split(',').map((v: string) => v.trim());

        if (operatorShort === 'between' && value.length !== 2) {
          throw new BadRequestException('BETWEEN requires exactly two values');
        }
      }

      // Null operators
      if (operatorShort === 'isnull' || operatorShort === 'notnull') {
        value = null;
      }

      return {
        column,
        operator,
        value,
      };
    });
  });
}

export function parseSort(sortStr?: string): Order[] {
  if (!sortStr) return [];

  return sortStr.split(',').map((part) => {
    const [column, direction = 'ASC'] = part.split(':');

    const dir = direction.toUpperCase();

    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new BadRequestException(`Invalid sort direction: ${direction}`);
    }

    return {
      column: decodeURIComponent(column.trim()),
      direction: dir,
    };
  });
}

export function parseFields(fieldsStr?: string): string[] {
  if (!fieldsStr) return [];

  return fieldsStr.split(',').map((f) => decodeURIComponent(f.trim()));
}
