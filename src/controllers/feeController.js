import pool from "../config/database.js";
import {
    sendSuccessResponse,
    sendErrorResponse
} from "../utils/response.js";

const PAYMENT_MODES = [
    "Cash",
    "UPI",
    "Bank Transfer",
    "Card",
    "Other"
];

function addMonths(dateString, months) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    // Clamp to the final day of the target month.
    const targetMonth = date.getUTCMonth() + months;
    const lastDay = new Date(
        Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)
    ).getUTCDate();

    date.setUTCDate(Math.min(day, lastDay));
    date.setUTCMonth(targetMonth);

    return date.toISOString().slice(0, 10);
}

function getPeriodEnd(fromDate, months) {
    const nextPeriod = addMonths(fromDate, months);
    const [year, month, day] = nextPeriod.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}




// POST /fees/collect
export async function collectFee(req, res) {
    let client;

    try {
        const {
            hosteller_id,
            fee_type,
            rate,
            number_of_days,
            from_date,
            amount,
            payment_date,
            payment_mode,
            reference_note
        } = req.body;

        // -----------------------------
        // 1. Basic validation
        // -----------------------------

        const hostellerId = Number(hosteller_id);
        const paidAmount = Number(amount);

        if (!Number.isInteger(hostellerId) || hostellerId <= 0) {
            return sendErrorResponse(res, 400, "Invalid hosteller ID");
        }

        if (!["Monthly", "Day-wise"].includes(fee_type)) {
            return sendErrorResponse(res, 400, "Invalid fee type");
        }

        if (!from_date || !payment_date) {
            return sendErrorResponse(
                res,
                400,
                "From date and payment date are required"
            );
        }

        const isValidDate = (value) => {
            if (
                typeof value !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(value)
            ) {
                return false;
            }

            const date = new Date(`${value}T00:00:00.000Z`);

            return (
                !Number.isNaN(date.getTime()) &&
                date.toISOString().slice(0, 10) === value
            );
        };

        if (!isValidDate(from_date)) {
            return sendErrorResponse(res, 400, "Invalid from date");
        }

        if (!isValidDate(payment_date)) {
            return sendErrorResponse(res, 400, "Invalid payment date");
        }

        if (payment_date < from_date) {
            return sendErrorResponse(
                res,
                400,
                "Payment date cannot be before the fee start date"
            );
        }

        if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
            return sendErrorResponse(
                res,
                400,
                "Payment amount must be greater than zero"
            );
        }

        if (!/^\d+(\.\d{1,2})?$/.test(String(amount))) {
            return sendErrorResponse(
                res,
                400,
                "Payment amount can have a maximum of 2 decimal places"
            );
        }

        const PAYMENT_MODES = [
            "Cash",
            "UPI",
            "Bank Transfer",
            "Card",
            "Cheque"
        ];

        if (!PAYMENT_MODES.includes(payment_mode)) {
            return sendErrorResponse(res, 400, "Invalid payment mode");
        }

        // -----------------------------
        // 2. Date calculation
        // -----------------------------

        const addDays = (dateString, days) => {
            const date = new Date(`${dateString}T00:00:00.000Z`);

            date.setUTCDate(date.getUTCDate() + days);

            return date.toISOString().slice(0, 10);
        };

        const getMonthlyPeriodEnd = (dateString) => {
            const date = new Date(`${dateString}T00:00:00.000Z`);

            const originalDay = date.getUTCDate();

            date.setUTCDate(1);
            date.setUTCMonth(date.getUTCMonth() + 1);

            const lastDayOfTargetMonth = new Date(
                Date.UTC(
                    date.getUTCFullYear(),
                    date.getUTCMonth() + 1,
                    0
                )
            ).getUTCDate();

            date.setUTCDate(
                Math.min(originalDay, lastDayOfTargetMonth)
            );

            date.setUTCDate(date.getUTCDate() - 1);

            return date.toISOString().slice(0, 10);
        };

        // -----------------------------
        // 3. Start transaction
        // -----------------------------

        client = await pool.connect();

        await client.query("BEGIN");

        const hostellerResult = await client.query(
            `SELECT
                h.hosteller_id,
                h.full_name,
                h.status AS hosteller_status,
                h.fee_plan,
                r.room_id,
                r.monthly_cost
             FROM tbl_hostellers h
             LEFT JOIN tbl_room_allocations a
                ON a.hosteller_id = h.hosteller_id
                AND a.status = 'ACTIVE'
             LEFT JOIN tbl_rooms r
                ON r.room_id = a.room_id
             WHERE h.hosteller_id = $1
             FOR UPDATE OF h`,
            [hostellerId]
        );

        if (hostellerResult.rowCount === 0) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                404,
                "Hosteller not found"
            );
        }

        const hosteller = hostellerResult.rows[0];

        if (hosteller.hosteller_status !== "Staying") {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                400,
                "Fee can only be collected from staying hostellers"
            );
        }

        if (!hosteller.room_id) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                400,
                "Hosteller does not have an active room allocation"
            );
        }

        if (hosteller.fee_plan !== fee_type) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                400,
                `Hosteller fee plan is ${hosteller.fee_plan}. Please select the correct fee type`
            );
        }

        // -----------------------------
        // 4. Calculate fee
        // -----------------------------

        let applicableRate;
        let numberOfDays = null;
        let periodEnd;
        let feeAmount;

        if (fee_type === "Monthly") {
            // Monthly calculation remains unchanged.
            applicableRate = Number(hosteller.monthly_cost);

            if (
                !Number.isFinite(applicableRate) ||
                applicableRate <= 0
            ) {
                await client.query("ROLLBACK");

                return sendErrorResponse(
                    res,
                    400,
                    "Invalid monthly room cost"
                );
            }

            periodEnd = getMonthlyPeriodEnd(from_date);

            // One month per collection
            feeAmount = Number(applicableRate.toFixed(2));
        }

        if (fee_type === "Day-wise") {
            // Admin enters rate per day and number of days.
            applicableRate = Number(rate);
            numberOfDays = Number(number_of_days);

            if (
                !Number.isFinite(applicableRate) ||
                applicableRate <= 0 ||
                !/^\d+(\.\d{1,2})?$/.test(String(rate))
            ) {
                await client.query("ROLLBACK");

                return sendErrorResponse(
                    res,
                    400,
                    "Please enter a valid daily rate"
                );
            }

            if (
                !Number.isInteger(numberOfDays) ||
                numberOfDays < 1 ||
                numberOfDays > 365
            ) {
                await client.query("ROLLBACK");

                return sendErrorResponse(
                    res,
                    400,
                    "Number of days must be between 1 and 365"
                );
            }

            periodEnd = addDays(from_date, numberOfDays - 1);

            // Total fee = rate per day * number of days
            feeAmount = Number(
                (applicableRate * numberOfDays).toFixed(2)
            );
        }

        // -----------------------------
        // 5. Check existing fee periods
        // -----------------------------

        const existingFeesResult = await client.query(
            `SELECT
                hf.fee_id,
                hf.fee_type,
                hf.rate,
                hf.number_of_days,
                hf.fee_period_start,
                hf.fee_period_end,
                hf.fee_amount,
                COALESCE(
                    payment_summary.total_paid,
                    0
                ) AS total_paid
             FROM tbl_hostel_fees hf
             LEFT JOIN (
                SELECT
                    fee_id,
                    SUM(amount_paid) AS total_paid
                FROM tbl_fee_payments
                GROUP BY fee_id
             ) payment_summary
                ON payment_summary.fee_id = hf.fee_id
             WHERE hf.hosteller_id = $1
                AND hf.fee_type = $2
                AND hf.fee_period_start = $3::date
                AND hf.fee_period_end = $4::date
             ORDER BY hf.fee_id DESC
             LIMIT 1
             FOR UPDATE OF hf`,
            [
                hostellerId,
                fee_type,
                from_date,
                periodEnd
            ]
        );

        const existingFee =
            existingFeesResult.rows[0] || null;

        // -----------------------------
        // 6. Calculate remaining balance
        // -----------------------------

        const previouslyPaid = existingFee
            ? Number(existingFee.total_paid)
            : 0;

        // If fee already exists, retain its original fee amount.
        // This is important for partial payments.
        const finalFeeAmount = existingFee
            ? Number(existingFee.fee_amount)
            : feeAmount;

        const finalRate = existingFee
            ? Number(existingFee.rate)
            : applicableRate;

        const finalNumberOfDays = existingFee
            ? existingFee.number_of_days
            : numberOfDays;

        const balance = Number(
            (finalFeeAmount - previouslyPaid).toFixed(2)
        );

        if (balance <= 0) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                400,
                "This fee is already fully paid"
            );
        }

        if (paidAmount > balance) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                400,
                `Payment amount cannot exceed the remaining balance of ${balance}`
            );
        }

        // -----------------------------
        // 7. Create or reuse fee record
        // -----------------------------

        let fee;

        if (existingFee) {
            fee = existingFee;
        } else {
            const feeResult = await client.query(
                `INSERT INTO tbl_hostel_fees (
                    hosteller_id,
                    fee_type,
                    number_of_days,
                    rate,
                    fee_period_start,
                    fee_period_end,
                    fee_amount
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *`,
                [
                    hostellerId,
                    fee_type,
                    numberOfDays,
                    applicableRate,
                    from_date,
                    periodEnd,
                    feeAmount
                ]
            );

            fee = feeResult.rows[0];
        }

        // -----------------------------
        // 8. Insert payment
        // -----------------------------

        const paymentResult = await client.query(
            `INSERT INTO tbl_fee_payments (
                fee_id,
                amount_paid,
                payment_date,
                payment_mode,
                reference_note
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *`,
            [
                fee.fee_id,
                paidAmount,
                payment_date,
                payment_mode,
                reference_note || null
            ]
        );

        const payment = paymentResult.rows[0];

        // -----------------------------
        // 9. Calculate final balance
        // -----------------------------

        const totalPaid = Number(
            (previouslyPaid + paidAmount).toFixed(2)
        );

        const remainingBalance = Number(
            (finalFeeAmount - totalPaid).toFixed(2)
        );

        const feeStatus =
            remainingBalance === 0
                ? "Paid"
                : totalPaid > 0
                    ? "Partially Paid"
                    : "Pending";

        // -----------------------------
        // 10. Commit transaction
        // -----------------------------

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            201,
            "Fee collected successfully",
            {
                fee,
                payment,
                fee_calculation: {
                    hosteller_id: hostellerId,
                    hosteller_name: hosteller.full_name,
                    fee_type,
                    rate: finalRate,
                    number_of_days: finalNumberOfDays,
                    fee_period_start: from_date,
                    fee_period_end: periodEnd,
                    total_fee: finalFeeAmount,
                    previously_paid: previouslyPaid,
                    amount_paid: paidAmount,
                    total_paid: totalPaid,
                    balance: remainingBalance,
                    status: feeStatus
                }
            }
        );

    } catch (error) {
        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Collect fee error:", error);

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status
                ? error.message
                : "Unable to collect fee"
        );

    } finally {
        if (client) {
            client.release();
        }
    }
}


export async function getFeeSummary(req, res) {
    try {
        const month =
            req.query.month || new Date().toISOString().slice(0, 7);

        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            return sendErrorResponse(
                res,
                400,
                "Invalid month. Use YYYY-MM format."
            );
        }

        const query = `
            WITH selected_month AS (
                SELECT
                    $1::date AS month_start,
                    ($1::date + INTERVAL '1 month')::date AS next_month
            ),

            hosteller_details AS (
                SELECT
                    h.hosteller_id,
                    h.full_name,
                    h.phone_number,
                    h.fee_plan,

                    b.building_name,
                    r.floor,
                    r.room_number,
                    r.sharing_type,

                    COALESCE(r.monthly_cost, 0)::NUMERIC
                        AS monthly_cost,

                    -- Fee details for the selected fee month
                    COALESCE(fee_summary.total_fee, 0)::NUMERIC
                        AS recorded_total_fee,

                    COALESCE(fee_summary.total_paid, 0)::NUMERIC
                        AS total_paid,

                    COALESCE(fee_summary.number_of_days, 0)::INTEGER
                        AS number_of_days,

                    fee_summary.day_wise_rate,

                    fee_summary.payment_date

                FROM tbl_hostellers h

                LEFT JOIN LATERAL (
                    SELECT
                        a.room_id
                    FROM tbl_room_allocations a
                    WHERE a.hosteller_id = h.hosteller_id
                      AND a.status = 'ACTIVE'
                    ORDER BY
                        a.allocation_date DESC,
                        a.allocation_id DESC
                    LIMIT 1
                ) allocation ON TRUE

                LEFT JOIN tbl_rooms r
                    ON r.room_id = allocation.room_id

                LEFT JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                CROSS JOIN selected_month sm

                -- Selected month's fee records and their payments
                LEFT JOIN LATERAL (
                    SELECT
                        SUM(hf.fee_amount) AS total_fee,

                        SUM(
                            COALESCE(hf.number_of_days, 0)
                        ) AS number_of_days,

                        (
                            ARRAY_AGG(
                                hf.rate
                                ORDER BY hf.fee_id DESC
                            )
                        )[1] AS day_wise_rate,

                        SUM(
                            COALESCE(payment.total_paid, 0)
                        ) AS total_paid,

                        MAX(
                            payment.last_payment_date
                        ) AS payment_date

                    FROM tbl_hostel_fees hf

                    LEFT JOIN LATERAL (
                        SELECT
                            SUM(fp.amount_paid) AS total_paid,
                            MAX(fp.payment_date)::DATE
                                AS last_payment_date
                        FROM tbl_fee_payments fp
                        WHERE fp.fee_id = hf.fee_id
                    ) payment ON TRUE

                    WHERE hf.hosteller_id = h.hosteller_id
                      AND hf.fee_period_start >= sm.month_start
                      AND hf.fee_period_start < sm.next_month

                ) fee_summary ON TRUE

                WHERE h.status = 'Staying'
            ),

            calculated_fees AS (
                SELECT
                    *,

                    -- Monthly rate comes from room monthly cost.
                    -- Day-wise rate comes from the fee record.
                    CASE
                        WHEN fee_plan = 'Monthly'
                            THEN monthly_cost
                        WHEN fee_plan = 'Day-wise'
                            THEN COALESCE(day_wise_rate, 0)
                        ELSE 0
                    END::NUMERIC AS rate,

                    -- Monthly: use recorded fee if available,
                    -- otherwise use room monthly cost.
                    -- Day-wise: use recorded fee only.
                    CASE
                        WHEN fee_plan = 'Monthly'
                            THEN
                                CASE
                                    WHEN recorded_total_fee > 0
                                        THEN recorded_total_fee
                                    ELSE monthly_cost
                                END

                        WHEN fee_plan = 'Day-wise'
                            THEN recorded_total_fee

                        ELSE 0
                    END::NUMERIC AS total_fee

                FROM hosteller_details
            ),

            final_fees AS (
                SELECT
                    *,

                    LEAST(total_paid, total_fee) AS paid,

                    GREATEST(
                        total_fee - total_paid,
                        0
                    ) AS balance

                FROM calculated_fees
            )

            SELECT
                COALESCE(SUM(total_fee), 0)
                    AS monthly_plan_total,

                COALESCE(SUM(paid), 0)
                    AS collected,

                COALESCE(SUM(balance), 0)
                    AS pending,

                COUNT(*) FILTER (
                    WHERE total_fee > 0
                      AND balance = 0
                ) AS fully_paid,

                COUNT(*) AS total_hostellers,

                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'hosteller_id', hosteller_id,
                            'hosteller', full_name,
                            'phone', phone_number,
                            'building', building_name,
                            'floor', floor,
                            'room_no', room_number,
                            'sharing', sharing_type,
                            'fee_plan', fee_plan,

                            'rate', rate,
                            'number_of_days',
                                CASE
                                    WHEN fee_plan = 'Day-wise'
                                        THEN number_of_days
                                    ELSE NULL
                                END,

                            'total_fee', total_fee,
                            'paid', paid,
                            'balance', balance,

                            'status',
                                CASE
                                    WHEN total_fee > 0
                                         AND balance = 0
                                        THEN 'Paid'
                                    WHEN paid > 0
                                        THEN 'Partial'
                                    ELSE 'Pending'
                                END,

                            'payment_date', payment_date
                        )
                        ORDER BY full_name
                    ),
                    '[]'::JSON
                ) AS hostellers

            FROM final_fees;
        `;

        const result = await pool.query(query, [`${month}-01`]);

        const row = result.rows[0];

        return sendSuccessResponse(
            res,
            200,
            "Fee summary fetched successfully",
            {
                month,
                summary: {
                    monthlyPlanTotal: Number(row.monthly_plan_total),
                    collected: Number(row.collected),
                    pending: Number(row.pending),
                    fullyPaid: Number(row.fully_paid),
                    totalHostellers: Number(row.total_hostellers)
                },
                hostellers: row.hostellers
            }
        );

    } catch (error) {
        console.error("Get fee summary error:", error);

        return sendErrorResponse(
            res,
            500,
            "Failed to fetch fee summary"
        );
    }
}

export async function getPaymentHistory(req, res) {
    try {
        const month =
            req.query.month || new Date().toISOString().slice(0, 7);

        const search = (req.query.search || "").trim();
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 20, 1),
            100
        );
        const offset = (page - 1) * limit;

        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Invalid month. Use YYYY-MM format."
            });
        }

        const query = `
            WITH payment_history AS (
                SELECT
                    'RC' || LPAD(fp.payment_id::text, 4, '0')
                        AS payment_id,

                    fp.payment_date AS paid_on,
                    h.full_name AS hosteller,

                    CASE
                        WHEN hf.fee_type = 'Day-wise'
                            THEN 'Day-wise × ' ||
                                ((hf.fee_period_end - hf.fee_period_start) + 1)::text ||
                                ' day(s)'

                        WHEN hf.fee_type = 'Weekly'
                            THEN 'Weekly'

                        WHEN hf.fee_type = 'Monthly'
                            THEN 'Monthly'

                        ELSE hf.fee_type
                    END AS fee_type,

                    TO_CHAR(hf.fee_period_start, 'YYYY-MM-DD')
                        || ' → ' ||
                    TO_CHAR(hf.fee_period_end, 'YYYY-MM-DD')
                        AS period,

                    fp.amount_paid AS amount,
                    fp.payment_mode AS mode,
                    fp.reference_note AS note

                FROM tbl_fee_payments fp

                JOIN tbl_hostel_fees hf
                    ON hf.fee_id = fp.fee_id

                JOIN tbl_hostellers h
                    ON h.hosteller_id = hf.hosteller_id

                WHERE fp.payment_date >= $1::date
                  AND fp.payment_date < (
                      $1::date + INTERVAL '1 month'
                  )
                  AND (
                      $2 = ''
                      OR h.full_name ILIKE '%' || $2 || '%'
                      OR h.phone_number ILIKE '%' || $2 || '%'
                      OR fp.payment_mode ILIKE '%' || $2 || '%'
                      OR fp.reference_note ILIKE '%' || $2 || '%'
                      OR (
                          'RC' || LPAD(fp.payment_id::text, 4, '0')
                      ) ILIKE '%' || $2 || '%'
                  )
            )
            SELECT
                *,
                COUNT(*) OVER() AS total_records
            FROM payment_history
            ORDER BY paid_on DESC, payment_id DESC
            LIMIT $3 OFFSET $4;
        `;

        const result = await pool.query(query, [
            `${month}-01`,
            search,
            limit,
            offset
        ]);

        const totalRecords = result.rows.length
            ? Number(result.rows[0].total_records)
            : 0;

        const payments = result.rows.map((row) => ({
            payment_id: row.payment_id,
            paid_on: row.paid_on,
            hosteller: row.hosteller,
            fee_type: row.fee_type,
            period: row.period,
            amount: Number(row.amount),
            mode: row.mode,
            note: row.note
        }));

        return res.status(200).json({
            success: true,
            data: {
                payments,
                pagination: {
                    page,
                    limit,
                    totalRecords,
                    totalPages: Math.ceil(totalRecords / limit)
                }
            },
            message: "Payment history fetched successfully"
        });
    } catch (error) {
        console.error("Get payment history error:", error);

        return res.status(500).json({
            success: false,
            data: null,
            message: "Failed to fetch payment history"
        });
    }
}



