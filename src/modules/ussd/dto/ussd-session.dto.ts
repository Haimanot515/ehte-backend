export type UssdStep =
  | 'ROOT'
  // Report an incident
  | 'REPORT_CATEGORY'
  | 'REPORT_DESCRIPTION'
  | 'REPORT_CONFIRM'
  // Check report status
  | 'STATUS_INPUT_REF'
  // Report a missing person
  | 'MISSING_PERSON_TYPE'
  | 'MISSING_PERSON_NAME'
  | 'MISSING_PERSON_DESCRIPTION'
  | 'MISSING_PERSON_DATE_LAST_SEEN'
  | 'MISSING_PERSON_LAST_AREA'
  | 'MISSING_PERSON_CONFIRM'
  // Provide information about a missing person
  | 'INFO_MISSING_PERSON_ID'
  | 'INFO_DESCRIPTION'
  | 'INFO_CONFIRM';

export interface UssdSessionState {
  sessionId: string;
  phoneNumber: string;
  step: UssdStep;
  data: Record<string, string>;
  createdAt: number;
}

export interface UssdInboundDto {
  sessionId: string;
  phoneNumber: string;
  /** The latest single input/keypress from the user. Empty string on session start. */
  input: string;
  serviceCode?: string;
}

export interface UssdOutboundResult {
  text: string;
  continueSession: boolean;
}
