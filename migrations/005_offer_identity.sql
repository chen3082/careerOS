-- New employer terms belong to revisions of the same offer, not competing outcomes.
CREATE UNIQUE INDEX one_offer_per_application ON offers(application_id);
