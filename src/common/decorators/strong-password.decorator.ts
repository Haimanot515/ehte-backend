import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

import {
  checkPassword,
  userPasswordMinLengthFromEnv,
} from 'src/common/utils/password-policy.util';

/**
 * DTO-level password strength check (user baseline: PASSWORD_MIN_LENGTH, default 8).
 *
 * Put it on fields where a password is CHOSEN (signup, reset, change, set, admin
 * registration). Never on login / currentPassword fields.
 *
 * Admins need a longer minimum (ADMIN_PASSWORD_MIN_LENGTH, default 12) and the
 * personal-info check; those run in AdminAuthService because the DTOs are shared.
 *
 * The validation message is the reason code, e.g. `password_too_short`.
 */
export function IsStrongPassword(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          return checkPassword(value, { minLength: userPasswordMinLengthFromEnv() }) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          const value = args.value;
          const reason =
            typeof value === 'string'
              ? checkPassword(value, { minLength: userPasswordMinLengthFromEnv() })
              : null;
          return reason ?? 'password_invalid';
        },
      },
    });
  };
}