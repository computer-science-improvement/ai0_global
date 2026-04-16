export interface OnThisDayEvent {
  year: string;
  description: string;
}

export interface OnThisDayItem {
  events: OnThisDayEvent[];
  births: OnThisDayEvent[];
  deaths: OnThisDayEvent[];
}
