ALTER TABLE `work_items` ADD `review_report_id` text REFERENCES work_messages(id) ON DELETE set null;
