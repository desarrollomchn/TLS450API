-- Índice de soporte para el job de retención de comb_lecturas (purga por CreatedAt).
-- El índice existente IX_comb_lecturas_TanqueId_CreatedAt tiene TanqueId como columna
-- líder, así que no sirve para un DELETE filtrado solo por fecha.
CREATE INDEX IX_comb_lecturas_CreatedAt ON comb_lecturas(CreatedAt);

-- Job de retención: purga comb_lecturas > 3 meses, corre diario 8:00 AM
-- (horario elegido a propósito: si algo falla, hay alguien despierto para arreglarlo).
USE msdb;
GO

EXEC sp_add_job
    @job_name = N'TLS450_Purge_comb_lecturas';

EXEC sp_add_jobstep
    @job_name = N'TLS450_Purge_comb_lecturas',
    @step_name = N'Delete rows older than 3 months',
    @subsystem = N'TSQL',
    @database_name = N'MonteCristoBO',
    @command = N'
DECLARE @cutoff DATETIME = DATEADD(MONTH, -3, GETDATE());
DECLARE @deleted INT = 1;

WHILE @deleted > 0
BEGIN
    DELETE TOP (5000) FROM comb_lecturas
    WHERE CreatedAt < @cutoff;

    SET @deleted = @@ROWCOUNT;
    IF @deleted > 0 WAITFOR DELAY ''00:00:01'';
END';

EXEC sp_add_schedule
    @schedule_name = N'Daily_0800',
    @freq_type = 4,          -- diario
    @freq_interval = 1,
    @active_start_time = 080000;  -- 08:00 AM

EXEC sp_attach_schedule
    @job_name = N'TLS450_Purge_comb_lecturas',
    @schedule_name = N'Daily_0800';

EXEC sp_add_jobserver
    @job_name = N'TLS450_Purge_comb_lecturas';
GO
