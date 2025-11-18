// Doctor Dashboard JavaScript
if (typeof firebase !== 'undefined' && typeof auth !== 'undefined') {
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            // Verify user is a doctor
            const userDoc = await db.collection('users').doc(user.uid).get();
            // Check if document exists (compat with both v8 and v9+ syntax)
            const docExists = userDoc.exists ? (typeof userDoc.exists === 'function' ? userDoc.exists() : userDoc.exists) : (userDoc.data() !== undefined);
            if (docExists && userDoc.data().role === 'doctor') {
                await loadDoctorDashboard();
            } else {
                alert('Access denied. Doctor access only.');
                window.location.href = 'index.html';
            }
        } else {
            window.location.href = 'index.html';
        }
    });
}

async function loadDoctorDashboard() {
    if (typeof db === 'undefined' || typeof auth === 'undefined' || !auth.currentUser) {
        document.getElementById('patients-table-body').innerHTML = '<tr><td colspan="7">Firebase not configured</td></tr>';
        return;
    }
    
    try {
        const currentDoctorId = auth.currentUser.uid;
        
        // Get all therapy sessions for this doctor only (without orderBy to avoid index requirement)
        const doctorSessionsSnapshot = await db.collection('therapySessions')
            .where('doctorId', '==', currentDoctorId)
            .get();
        
        // Sort sessions by timestamp in memory (descending - most recent first)
        const sortedSessions = doctorSessionsSnapshot.docs.sort((a, b) => {
            const timeA = a.data().timestamp ? a.data().timestamp.toDate().getTime() : 0;
            const timeB = b.data().timestamp ? b.data().timestamp.toDate().getTime() : 0;
            return timeB - timeA; // Descending order
        });
        
        const patientsTableBody = document.getElementById('patients-table-body');
        const recentSessionsList = document.getElementById('recent-sessions-list');
        
        if (sortedSessions.length === 0) {
            patientsTableBody.innerHTML = '<tr><td colspan="7">No patients found. Start treating patients to see them here.</td></tr>';
            recentSessionsList.innerHTML = '<p>No recent sessions</p>';
            // Reset analytics
            document.getElementById('total-patients').textContent = '0';
            document.getElementById('active-patients').textContent = '0';
            document.getElementById('avg-rating').textContent = '-';
            document.getElementById('success-rate').textContent = '0%';
            return;
        }
        
        // Extract unique patient emails/names from doctor's sessions
        const patientEmails = new Set();
        const patientNames = new Set();
        sortedSessions.forEach(doc => {
            const sessionData = doc.data();
            if (sessionData.patientEmail) {
                patientEmails.add(sessionData.patientEmail.toLowerCase());
            }
            if (sessionData.patientName) {
                patientNames.add(sessionData.patientName);
            }
        });
        
        // Get recent sessions for this doctor only (limit 10)
        const recentSessions = sortedSessions.slice(0, 10);
        
        let html = '';
        let totalPatients = 0;
        let activePatients = 0;
        let totalRating = 0;
        let ratingCount = 0;
        let improvedCount = 0;
        let totalSessionsCount = 0;
        
        // Display recent sessions
        
        let recentSessionsHtml = '';
        if (recentSessions.length > 0) {
            recentSessions.forEach(sessionDoc => {
                const sessionData = sessionDoc.data();
                const sessionDate = sessionData.timestamp ? 
                    new Date(sessionData.timestamp.toDate()).toLocaleDateString() : 'N/A';
                const duration = sessionData.duration ? 
                    Math.floor(sessionData.duration / 60) + ' min ' + (sessionData.duration % 60) + ' sec' : 'N/A';
                
                recentSessionsHtml += `
                    <div class="session-card">
                        <div class="session-header">
                            <h4>${sessionData.patientName || 'Unknown Patient'}</h4>
                            <span class="session-date">${sessionDate}</span>
                        </div>
                        <div class="session-details">
                            <p><strong>Environment:</strong> ${getEnvironmentName(sessionData.environment)}</p>
                            <p><strong>Duration:</strong> ${duration}</p>
                            <p><strong>Stress Level After:</strong> ${sessionData.stressRatingAfter || 'N/A'}/5</p>
                            <p><strong>Recovery Status:</strong> <span class="recovery-badge ${sessionData.recoveryStatus || 'no_change'}">${getRecoveryStatusText(sessionData.recoveryStatus)}</span></p>
                        </div>
                    </div>
                `;
            });
        } else {
            recentSessionsHtml = '<p>No recent sessions</p>';
        }
        recentSessionsList.innerHTML = recentSessionsHtml;
        
        // Group sessions by patient to get patient statistics
        const patientSessionsMap = new Map();
        sortedSessions.forEach(doc => {
            const sessionData = doc.data();
            const patientKey = sessionData.patientEmail || sessionData.patientName;
            if (!patientKey) return;
            
            if (!patientSessionsMap.has(patientKey)) {
                patientSessionsMap.set(patientKey, {
                    patientName: sessionData.patientName,
                    patientEmail: sessionData.patientEmail,
                    patientAge: sessionData.patientAge,
                    sessions: []
                });
            }
            patientSessionsMap.get(patientKey).sessions.push(sessionData);
        });
        
        // Load patient records for patients treated by this doctor
        const patientPromises = Array.from(patientSessionsMap.keys()).map(async (patientKey) => {
            let patientDocId;
            const patientInfo = patientSessionsMap.get(patientKey);
            
            // Try email first, then name
            if (patientInfo.patientEmail) {
                patientDocId = patientInfo.patientEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
            } else if (patientInfo.patientName) {
                patientDocId = patientInfo.patientName.toLowerCase().replace(/\s+/g, '_');
            } else {
                return null;
            }
            
            try {
                const patientDoc = await db.collection('patients').doc(patientDocId).get();
                const docExists = patientDoc.exists ? (typeof patientDoc.exists === 'function' ? patientDoc.exists() : patientDoc.exists) : (patientDoc.data() !== undefined);
                
                if (docExists) {
                    const patientData = patientDoc.data();
                    // Filter sessions to only include this doctor's sessions
                    const doctorSessions = patientInfo.sessions;
                    return {
                        ...patientData,
                        doctorSessions: doctorSessions,
                        totalDoctorSessions: doctorSessions.length
                    };
                } else {
                    // Patient record doesn't exist, use session data
                    return {
                        patientName: patientInfo.patientName,
                        patientEmail: patientInfo.patientEmail,
                        patientAge: patientInfo.patientAge,
                        doctorSessions: patientInfo.sessions,
                        totalDoctorSessions: patientInfo.sessions.length,
                        sessions: []
                    };
                }
            } catch (error) {
                console.error('Error loading patient:', error);
                return null;
            }
        });
        
        const patientRecords = (await Promise.all(patientPromises)).filter(p => p !== null);
        
        // Process each patient
        for (const patientData of patientRecords) {
            totalPatients++;
            
            const patientName = patientData.patientName || 'Unknown';
            const patientAge = patientData.patientAge || 'N/A';
            const doctorSessions = patientData.doctorSessions || [];
            const totalSessions = doctorSessions.length;
            totalSessionsCount += totalSessions;
            
            if (totalSessions > 0) activePatients++;
            
            // Get latest session data (from this doctor's sessions)
            const latestSession = doctorSessions.length > 0 
                ? doctorSessions.sort((a, b) => {
                    const timeA = a.timestamp ? a.timestamp.toDate().getTime() : 0;
                    const timeB = b.timestamp ? b.timestamp.toDate().getTime() : 0;
                    return timeB - timeA;
                })[0]
                : null;
            
            // Get latest stress level - prefer from latest session, fallback to patient's latestStressLevel
            let latestStress = patientData.latestStressLevel || 'N/A';
            let recoveryStatus = 'No sessions';
            let recoveryClass = 'no_change';
            let lastSessionDate = 'N/A';
            
            if (latestSession) {
                // Use stressRatingAfter from session if available
                if (latestSession.stressRatingAfter !== undefined) {
                    latestStress = latestSession.stressRatingAfter;
                } else if (latestSession.stressRating !== undefined) {
                    latestStress = latestSession.stressRating;
                }
                
                recoveryStatus = getRecoveryStatusText(latestSession.recoveryStatus);
                recoveryClass = latestSession.recoveryStatus || 'no_change';
                
                // Count improved sessions for success rate
                if (latestSession.recoveryStatus === 'improved' || latestSession.recoveryStatus === 'slightly_improved') {
                    improvedCount++;
                }
                
                if (latestSession.timestamp) {
                    lastSessionDate = new Date(latestSession.timestamp.toDate()).toLocaleDateString();
                }
            } else if (patientData.lastSession) {
                // Use lastSession timestamp if available
                lastSessionDate = new Date(patientData.lastSession.toDate()).toLocaleDateString();
            }
            
            // Count all improved sessions for this doctor
            doctorSessions.forEach(session => {
                if (session.recoveryStatus === 'improved' || session.recoveryStatus === 'slightly_improved') {
                    // Count each improved session
                }
            });
            
            // Calculate average effectiveness rating from this doctor's sessions
            let avgRating = '-';
            const sessionsWithRating = doctorSessions.filter(s => s.stressRatingAfter !== undefined || s.stressRating !== undefined);
            if (sessionsWithRating.length > 0) {
                const sum = sessionsWithRating.reduce((acc, s) => acc + (s.stressRatingAfter || s.stressRating || 0), 0);
                avgRating = (sum / sessionsWithRating.length).toFixed(1);
                totalRating += parseFloat(avgRating);
                ratingCount++;
            } else if (patientData.averageScore !== undefined) {
                avgRating = patientData.averageScore.toFixed(1);
                totalRating += parseFloat(avgRating);
                ratingCount++;
            }
            
            html += `
                <tr>
                    <td><strong>${patientName}</strong></td>
                    <td>${patientAge}</td>
                    <td>${totalSessions}</td>
                    <td>${latestStress}/5</td>
                    <td><span class="recovery-badge ${recoveryClass}">${recoveryStatus}</span></td>
                    <td>${lastSessionDate}</td>
                    <td><button class="view-details-btn" onclick="viewPatientDetails('${patientName}', '${patientData.patientEmail || ''}')">View Details</button></td>
                </tr>
            `;
        }
        
        patientsTableBody.innerHTML = html;
        
        // Update analytics
        document.getElementById('total-patients').textContent = totalPatients;
        document.getElementById('active-patients').textContent = activePatients;
        const avgRatingValue = ratingCount > 0 ? (totalRating / ratingCount).toFixed(1) : '-';
        document.getElementById('avg-rating').textContent = avgRatingValue;
        
        // Calculate success rate (sessions with improvement) - only for this doctor's sessions
        let totalImprovedSessions = 0;
        patientRecords.forEach(patientData => {
            const doctorSessions = patientData.doctorSessions || [];
            doctorSessions.forEach(session => {
                if (session.recoveryStatus === 'improved' || session.recoveryStatus === 'slightly_improved') {
                    totalImprovedSessions++;
                }
            });
        });
        
        const successRate = totalSessionsCount > 0 ? ((totalImprovedSessions / totalSessionsCount) * 100).toFixed(0) : '0';
        document.getElementById('success-rate').textContent = successRate + '%';
        
    } catch (error) {
        console.error('Error loading doctor dashboard:', error);
        document.getElementById('patients-table-body').innerHTML = '<tr><td colspan="7">Error loading patients</td></tr>';
    }
}

async function viewPatientDetails(patientName, patientEmail = '') {
    const modal = document.getElementById('patient-details-modal');
    const content = document.getElementById('patient-details-content');
    const nameEl = document.getElementById('patient-details-name');
    
    if (typeof auth === 'undefined' || !auth.currentUser) {
        alert('Please log in to view patient details');
        return;
    }
    
    const currentDoctorId = auth.currentUser.uid;
    
    try {
        // Determine patient document ID
        let patientDocId;
        if (patientEmail) {
            patientDocId = patientEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
        } else {
            patientDocId = patientName.toLowerCase().replace(/\s+/g, '_');
        }
        
        const patientDoc = await db.collection('patients').doc(patientDocId).get();
        
        // Check if document exists (compat with both v8 and v9+ syntax)
        const docExists = patientDoc.exists ? (typeof patientDoc.exists === 'function' ? patientDoc.exists() : patientDoc.exists) : (patientDoc.data() !== undefined);
        
        let patientData = {};
        if (docExists) {
            patientData = patientDoc.data();
        }
        
        nameEl.textContent = `Patient: ${patientData.patientName || patientName}`;
        
        // Get all sessions for this patient treated by this doctor only (without orderBy to avoid index requirement)
        let sessionsQuery = db.collection('therapySessions')
            .where('doctorId', '==', currentDoctorId);
        
        if (patientEmail) {
            sessionsQuery = sessionsQuery.where('patientEmail', '==', patientEmail);
        } else {
            sessionsQuery = sessionsQuery.where('patientName', '==', patientName);
        }
        
        const sessionsSnapshot = await sessionsQuery.get();
        
        // Sort sessions by timestamp in memory (descending - most recent first)
        const sortedPatientSessions = sessionsSnapshot.docs.sort((a, b) => {
            const timeA = a.data().timestamp ? a.data().timestamp.toDate().getTime() : 0;
            const timeB = b.data().timestamp ? b.data().timestamp.toDate().getTime() : 0;
            return timeB - timeA; // Descending order
        });
        
        // Get all feedback for this patient treated by this doctor only (without orderBy to avoid index requirement)
        let feedbackQuery = db.collection('sessionFeedback')
            .where('userId', '==', currentDoctorId);
        
        if (patientEmail) {
            feedbackQuery = feedbackQuery.where('patientEmail', '==', patientEmail);
        } else {
            feedbackQuery = feedbackQuery.where('patientName', '==', patientName);
        }
        
        const feedbackSnapshot = await feedbackQuery.get();
        
        // Sort feedback by timestamp in memory (descending - most recent first)
        const sortedFeedback = feedbackSnapshot.docs.sort((a, b) => {
            const timeA = a.data().timestamp ? a.data().timestamp.toDate().getTime() : 0;
            const timeB = b.data().timestamp ? b.data().timestamp.toDate().getTime() : 0;
            return timeB - timeA; // Descending order
        });
        
        let html = `
            <div class="patient-details">
                <div class="patient-info-summary">
                    <p><strong>Age:</strong> ${patientData.patientAge || 'N/A'}</p>
                    <p><strong>Total Sessions:</strong> ${patientData.totalSessions || 0}</p>
                    <p><strong>Latest Stress Level:</strong> ${patientData.latestStressLevel || 'N/A'}</p>
                    <p><strong>Latest Score:</strong> ${patientData.latestScore !== undefined ? patientData.latestScore + '/100' : 'N/A'}</p>
                    <p><strong>Average Score:</strong> ${patientData.averageScore !== undefined ? patientData.averageScore + '/100' : 'N/A'}</p>
                    <p><strong>Progress:</strong> ${patientData.progress !== undefined ? (patientData.progress > 0 ? '+' : '') + patientData.progress + ' points' : 'N/A'}</p>
                    <p><strong>Last Session:</strong> ${patientData.lastSession ? new Date(patientData.lastSession.toDate()).toLocaleDateString() : 'N/A'}</p>
                </div>
                
                <h3>All Therapy Sessions</h3>
                <div class="details-section">
                    ${sortedPatientSessions.length === 0
                        ? '<p>No sessions recorded</p>'
                        : sortedPatientSessions.map(doc => {
                            const session = doc.data();
                            const date = session.timestamp ? new Date(session.timestamp.toDate()).toLocaleDateString() : 'N/A';
                            const duration = session.duration ? Math.floor(session.duration / 60) + ' min' : 'N/A';
                            return `
                                <div class="session-detail-item">
                                    <p><strong>Date:</strong> ${date}</p>
                                    <p><strong>Environment:</strong> ${getEnvironmentName(session.environment)}</p>
                                    <p><strong>Duration:</strong> ${duration}</p>
                                    <p><strong>Stress Level Before:</strong> ${session.stressLevelBefore || 'N/A'}</p>
                                    <p><strong>Stress Level After:</strong> ${session.stressRatingAfter || 'N/A'}/5</p>
                                    <p><strong>Session Score:</strong> ${session.sessionScore !== undefined ? session.sessionScore + '/100' : 'N/A'}</p>
                                    <p><strong>Recovery Status:</strong> <span class="recovery-badge ${session.recoveryStatus || 'no_change'}">${getRecoveryStatusText(session.recoveryStatus)}</span></p>
                                    <p><strong>Relaxation:</strong> ${session.relaxationStatus === 'yes' ? '✅ Much More Relaxed' : session.relaxationStatus === 'somewhat' ? '👍 Somewhat Relaxed' : '➡️ No Change'}</p>
                                    ${session.comments ? `<p><strong>Notes:</strong> ${session.comments}</p>` : ''}
                                    <hr>
                                </div>
                            `;
                        }).join('')
                    }
                </div>
                
                <h3>Session Feedback Summary</h3>
                <div class="details-section">
                    ${sortedFeedback.length === 0
                        ? '<p>No feedback recorded</p>'
                        : sortedFeedback.map(doc => {
                            const feedback = doc.data();
                            const date = feedback.timestamp ? new Date(feedback.timestamp.toDate()).toLocaleDateString() : 'N/A';
                            return `
                                <div class="feedback-detail-item">
                                    <p><strong>Date:</strong> ${date}</p>
                                    <p><strong>Stress Level:</strong> ${feedback.stressRatingAfter || 'N/A'}/5</p>
                                    <p><strong>Effectiveness:</strong> ${feedback.effectivenessRating || 'N/A'}/5</p>
                                    <p><strong>Recovery Status:</strong> <span class="recovery-badge ${feedback.recoveryStatus || 'no_change'}">${getRecoveryStatusText(feedback.recoveryStatus)}</span></p>
                                    ${feedback.comments ? `<p><strong>Comments:</strong> ${feedback.comments}</p>` : ''}
                                    <hr>
                                </div>
                            `;
                        }).join('')
                    }
                </div>
            </div>
        `;
        
        content.innerHTML = html;
        modal.classList.remove('hidden');
    } catch (error) {
        console.error('Error loading patient details:', error);
        content.innerHTML = '<p>Error loading patient details</p>';
    }
}

function closePatientDetails() {
    document.getElementById('patient-details-modal').classList.add('hidden');
}

// Helper function to get environment name
function getEnvironmentName(environment) {
    const names = {
        'beach': 'Beach Paradise',
        'forest': 'Forest Sanctuary',
        'mountain': 'Mountain Peak',
        'zen': 'Zen Garden',
        'space': 'Space Observatory'
    };
    return names[environment] || environment;
}

// Helper function to get recovery status text
function getRecoveryStatusText(status) {
    const statusMap = {
        'improved': '✅ Improved',
        'slightly_improved': '👍 Slightly Improved',
        'no_change': '➡️ No Change'
    };
    return statusMap[status] || 'Unknown';
}

// Refresh dashboard function
function refreshDashboard() {
    loadDoctorDashboard();
}

