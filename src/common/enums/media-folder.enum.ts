// Mirrors the six media-array fields already used by VictimProfile
// (and, per PostService's shared MEDIA_FIELD_NAMES convention, by
// Post/Report too): photo, video, audio, pdf, document, other.
//
// Restricting `folder` to this enum — rather than accepting any
// free-text string, which is what MinioService.generatePresignedUploadUrl()
// itself would otherwise allow — keeps every object key produced by
// this endpoint consistent with the folder/field naming the rest of
// the app already assumes (e.g. `victim-profiles/photos/<uuid>.jpg`
// style keys). It also stops a caller from writing into an arbitrary
// bucket path.
export enum MediaFolder {
  PHOTO = 'photo',
  VIDEO = 'video',
  AUDIO = 'audio',
  PDF = 'pdf',
  DOCUMENT = 'document',
  OTHER = 'other',
}
