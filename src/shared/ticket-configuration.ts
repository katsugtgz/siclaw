export function ticketHostRequiredDetail() {
  return {
    code: "TICKET_HOST_REQUIRED",
    message: "Configure this Ticket Agent in the integrated host tenant UI",
    status: 409,
    retriable: false,
  };
}
