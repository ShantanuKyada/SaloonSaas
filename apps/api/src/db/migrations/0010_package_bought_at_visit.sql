-- 0010 A package (or combo) can be chosen while booking or registering a walk-in, then sold on that visit's bill with
-- its sessions used for the services of the same visit. The booking remembers which package the customer is buying
-- for each service; billing turns it into the package sale plus package sessions (see draftFromAppointment).

alter table appointment_items add column buy_package_id uuid;

alter table appointment_items add constraint appointment_items_buy_package_fk
  foreign key (organization_id, buy_package_id) references packages (organization_id, id);

-- A service is paid for by a package the customer already owns, or by one bought at this visit, never both.
alter table appointment_items add constraint appointment_items_one_package
  check (buy_package_id is null or customer_package_item_id is null);

create index appointment_items_buy_package on appointment_items (buy_package_id) where buy_package_id is not null;
