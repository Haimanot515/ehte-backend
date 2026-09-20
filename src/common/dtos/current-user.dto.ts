export class CurrentUserDto {
  id: string;
  phone: string;
  roles: string[];
  permissions: string[]; // was already returned by JwtStrategy.validate() but missing from this DTO — added
  sessionId: string;
}