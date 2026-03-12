-- Phase 1 regression checks for case transition enforcement.
-- Run after applying migrations (including 20260306).

do $$
begin
  -- Allowed transitions
  if not public.is_case_status_transition_allowed('ATTORNEY', 'CLIENT_DOCS_REQUIRED', 'IN_PROGRESS') then
    raise exception 'Expected ATTORNEY CLIENT_DOCS_REQUIRED -> IN_PROGRESS to be allowed';
  end if;

  if not public.is_case_status_transition_allowed('AGENCY_FLEET', 'NEEDS_REVIEW', 'ATTORNEY_MATCHING') then
    raise exception 'Expected AGENCY_FLEET NEEDS_REVIEW -> ATTORNEY_MATCHING to be allowed';
  end if;

  if not public.is_case_status_transition_allowed('STAFF', 'AWAITING_DISPOSITION', 'DISPOSITION_RECEIVED') then
    raise exception 'Expected STAFF AWAITING_DISPOSITION -> DISPOSITION_RECEIVED to be allowed';
  end if;

  -- ATTORNEY illegal transition should fail
  begin
    perform public.assert_case_status_transition_for_actor('ATTORNEY', 'ATTORNEY_ACCEPTED', 'NEEDS_REVIEW');
    raise exception 'Expected ATTORNEY ATTORNEY_ACCEPTED -> NEEDS_REVIEW to fail';
  exception
    when others then
      if position('CASE_STATUS_TRANSITION_BLOCKED' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- AGENCY/FLEET out-of-order jump should fail
  begin
    perform public.assert_case_status_transition_for_actor('AGENCY_FLEET', 'ATTORNEY_MATCHING', 'CLOSED');
    raise exception 'Expected AGENCY_FLEET ATTORNEY_MATCHING -> CLOSED to fail';
  exception
    when others then
      if position('CASE_STATUS_TRANSITION_BLOCKED' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- STAFF out-of-order jump should fail
  begin
    perform public.assert_case_status_transition_for_actor('STAFF', 'NEEDS_REVIEW', 'CLOSED');
    raise exception 'Expected STAFF NEEDS_REVIEW -> CLOSED to fail';
  exception
    when others then
      if position('CASE_STATUS_TRANSITION_BLOCKED' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end;
$$;

